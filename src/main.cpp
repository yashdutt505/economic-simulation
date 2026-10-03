#include <chrono>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
volatile std::sig_atomic_t stopping = 0;
void stop(int) { stopping = 1; }

// Money uses integer units; this model has one household and one firm.
struct Household { long long money = 100; };
struct Firm { long long money = 100; long long inventory = 0; };
struct TickResult {
    bool produced = false;
    bool consumed = false;
    long long household_before = 0, firm_before = 0, inventory_before = 0;
    long long household_after_work = 0, firm_after_work = 0, inventory_after_work = 0;
};
struct Economy {
    long long tick = 0;
    Household household;
    Firm firm;

    TickResult step() {
        if (tick == std::numeric_limits<long long>::max())
            throw std::runtime_error("tick limit reached");
        const long long wage = 10;
        const long long price = 10;
        TickResult result;
        result.household_before = household.money;
        result.firm_before = firm.money;
        result.inventory_before = firm.inventory;
        // Employment: pay for labor, then produce one unit.
        if (firm.money >= wage) {
            firm.money -= wage;
            household.money += wage;
            ++firm.inventory;
            result.produced = true;
        }
        result.household_after_work = household.money;
        result.firm_after_work = firm.money;
        result.inventory_after_work = firm.inventory;
        // Trade: buy one unit, which is consumed immediately.
        const bool traded = firm.inventory > 0 && household.money >= price;
        if (traded) {
            household.money -= price;
            firm.money += price;
            --firm.inventory;
        }
        ++tick;
        result.consumed = traded;
        return result;
    }
};

void load(Economy& economy, const std::string& path) {
    std::ifstream input(path);
    if (!input) {
        // Only a nonexistent file is a fresh start; unreadable files are errors.
        FILE* file = std::fopen(path.c_str(), "r");
        if (file) { std::fclose(file); throw std::runtime_error("cannot read state"); }
        if (errno == ENOENT) return;
        throw std::runtime_error("cannot open state: " + path);
    }
    std::string version, extra;
    Economy loaded;
    if (!(input >> version >> loaded.tick >> loaded.household.money
                >> loaded.firm.money >> loaded.firm.inventory)
        || version != "economy-v1" || (input >> extra)
        || loaded.tick < 0 || loaded.household.money < 0
        || loaded.household.money > 200 || loaded.firm.money < 0
        || loaded.firm.money != 200 - loaded.household.money
        || loaded.firm.inventory < 0 || loaded.firm.inventory > 200)
        throw std::runtime_error("invalid state: " + path);
    economy = loaded;
}

void save(const Economy& economy, const std::string& path) {
    const std::string temporary = path + ".tmp";
    std::ofstream output(temporary, std::ios::trunc);
    output << "economy-v1 " << economy.tick << ' ' << economy.household.money
           << ' ' << economy.firm.money << ' ' << economy.firm.inventory << '\n';
    output.close();
    if (!output) throw std::runtime_error("cannot write state: " + temporary);
#ifdef _WIN32
    if (!MoveFileExA(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING))
#else
    if (std::rename(temporary.c_str(), path.c_str()) != 0)
#endif
        throw std::runtime_error("cannot replace state: " + path);
}

// One JSON object per line: both the dashboard and CLI observe the same engine.
void report(const Economy& economy, const TickResult& result, bool json) {
    if (!json) {
        std::cout << "tick=" << economy.tick
                  << " household_money=" << economy.household.money
                  << " firm_money=" << economy.firm.money
                  << " inventory=" << economy.firm.inventory
                  << " consumed=" << (result.consumed ? 1 : 0) << std::endl;
        return;
    }
    // Tick is a string to preserve 64-bit precision in JavaScript.
    std::cout << "{\"tick\":\"" << economy.tick << "\",\"household_money\":" << economy.household.money
              << ",\"firm_money\":" << economy.firm.money
              << ",\"inventory\":" << economy.firm.inventory
              << ",\"produced\":" << (result.produced ? 1 : 0)
              << ",\"consumed\":" << (result.consumed ? 1 : 0)
              << ",\"before\":{\"household_money\":" << result.household_before
              << ",\"firm_money\":" << result.firm_before
              << ",\"inventory\":" << result.inventory_before
              << "},\"after_work\":{\"household_money\":" << result.household_after_work
              << ",\"firm_money\":" << result.firm_after_work
              << ",\"inventory\":" << result.inventory_after_work << "}}" << std::endl;
}

long long number(const std::string& value) {
    std::size_t used = 0;
    const auto result = std::stoll(value, &used);
    if (used != value.size() || result < 0)
        throw std::runtime_error("expected a nonnegative integer: " + value);
    return result;
}
} // namespace

int main(int argc, char** argv) {
    try {
        long long ticks = 10, interval = 1000;
        bool forever = false, json = false;
        std::string state;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--help") {
                std::cout << "economy [--ticks N | --forever] [--interval-ms N] [--state PATH] [--json]\n"
                          << "Defaults: 10 ticks, 1000 ms between ticks, no persistence.\n";
                return 0;
            }
            if (arg == "--forever") { forever = true; continue; }
            if (arg == "--json") { json = true; continue; }
            if (i + 1 >= argc) throw std::runtime_error("missing value: " + arg);
            const std::string value = argv[++i];
            if (arg == "--ticks") ticks = number(value);
            else if (arg == "--interval-ms") interval = number(value);
            else if (arg == "--state") state = value;
            else throw std::runtime_error("unknown option: " + arg);
        }
        if (interval > 86400000) throw std::runtime_error("interval must be <= 86400000 ms");
        if (forever && interval == 0) throw std::runtime_error("continuous mode needs a positive interval");
        std::signal(SIGINT, stop);
        std::signal(SIGTERM, stop);
        Economy economy;
        if (!state.empty()) load(economy, state);
        for (long long ran = 0; !stopping && (forever || ran < ticks);) {
            const auto result = economy.step();
            if (!state.empty()) save(economy, state);
            report(economy, result, json);
            if (!forever) ++ran;
            if (!forever && ran == ticks) break;
            // Short sleeps let termination signals stop the worker promptly.
            for (long long remaining = interval; !stopping && remaining > 0;) {
                const auto chunk = remaining > 100 ? 100 : remaining;
#ifdef _WIN32
                Sleep(static_cast<DWORD>(chunk));
#else
                std::this_thread::sleep_for(std::chrono::milliseconds(chunk));
#endif
                remaining -= chunk;
            }
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
