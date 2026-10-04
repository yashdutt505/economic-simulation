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

// Money uses integer units; the market observes household/firm exchanges.
struct Household {
    long long money = 100;
    long long stock = 0;
    long long needs = 2; // Desired stock, not consumption per tick.
};
struct Firm {
    long long money = 100;
    long long inventory = 0;
    long long price = 12; // The firm's quote; the market supplies feedback.
};
// Goods are sent as JSON numbers; keep them exact in JavaScript as well as C++.
const long long max_goods = 9007199254740991LL;
const long long wage = 10;
const long long production_batch = 10;
const long long production_threshold = 5;
const long long price_period = 5, min_price = 1, max_price = 30;

// Reason codes are stored in checkpoints; only these fixed labels enter JSON.
const char* price_reason(long long code) {
    const char* labels[] = {"waiting", "affordability", "scarcity", "unsold_goods", "stable", "price_floor", "price_ceiling"};
    return labels[code];
}
struct Market {
    long long samples = 0, requested = 0, affordable = 0, sales = 0;
    long long unsold_ticks = 0, stockout_ticks = 0, last_reason = 0;

    void observe(long long demand, long long budget_demand, long long supply, bool sold) {
        ++samples;
        requested += demand;
        affordable += budget_demand;
        sales += sold ? 1 : 0;
        if (supply > 0 && !sold) ++unsold_ticks;
        if (budget_demand > 0 && supply == 0) ++stockout_ticks;
    }

    long long update_price(Firm& firm) {
        if (samples < price_period) return 0;
        long long direction = 0;
        last_reason = 4;
        // Unsold supply with cash-constrained buyers: raising prices would worsen it.
        if (requested > affordable && firm.inventory > 0) {
            direction = -1; last_reason = 1;
        } else if (stockout_ticks > 0 || (sales > 0 && firm.inventory < production_threshold)) {
            direction = 1; last_reason = 2;
        } else if (unsold_ticks > 0) {
            direction = -1; last_reason = 3;
        }
        if (direction < 0 && firm.price == min_price) last_reason = 5;
        else if (direction > 0 && firm.price == max_price) last_reason = 6;
        else firm.price += direction;
        samples = requested = affordable = sales = unsold_ticks = stockout_ticks = 0;
        return last_reason;
    }
};
struct TickResult {
    long long produced = 0; // Quantity, not just whether production happened.
    bool purchased = false;
    bool consumed = false;
    bool unmet_need = false;
    long long trade_price = 0, price_decision = 0;
    long long desired_goods = 0, requested_goods = 0, affordable_goods = 0, offered_goods = 0;
    long long household_before = 0, firm_before = 0, inventory_before = 0;
    long long household_after_work = 0, firm_after_work = 0, inventory_after_work = 0;
    long long household_stock_before_trade = 0, household_stock_after_trade = 0;
    long long household_stock_before_consumption = 0, household_stock_after_consumption = 0;
};
struct Economy {
    long long tick = 0;
    Household household;
    Firm firm;
    Market market;
    long long total_money = 200;
    TickResult step() {
        if (tick == std::numeric_limits<long long>::max())
            throw std::runtime_error("tick limit reached");
        TickResult result;
        result.household_before = household.money;
        result.firm_before = firm.money;
        result.inventory_before = firm.inventory;
        // Employment and Production
        if (firm.money >= wage && firm.inventory < production_threshold) {
            if (firm.inventory > max_goods - production_batch)
                throw std::runtime_error("inventory limit reached");
            firm.money -= wage;
            household.money += wage;
            firm.inventory += production_batch;
            result.produced = production_batch;
        }
        result.household_after_work = household.money;
        result.firm_after_work = firm.money;
        result.inventory_after_work = firm.inventory;

        result.household_stock_before_trade = household.stock;
        result.trade_price = firm.price;
        result.desired_goods = household.needs > household.stock ? household.needs - household.stock : 0;
        result.requested_goods = result.desired_goods > 0 ? 1 : 0;
        result.affordable_goods = result.requested_goods && household.money >= firm.price ? 1 : 0;
        result.offered_goods = firm.inventory;
        // Purchase one unit only while below the desired stock. Keep it in storage.
        const bool traded = result.offered_goods > 0 && result.affordable_goods > 0;
        if (traded) {
            household.money -= result.trade_price;
            firm.money += result.trade_price;
            --firm.inventory;
            ++household.stock;
        }
        result.purchased = traded;
        result.household_stock_after_trade = household.stock;
        // Consumption
        result.household_stock_before_consumption = household.stock;
        if (household.stock > 0) {
            --household.stock;
            result.consumed = true;
        }
        result.unmet_need = !result.consumed;
        result.household_stock_after_consumption = household.stock;
        market.observe(result.requested_goods, result.affordable_goods, result.offered_goods, traded);
        // The current tick uses the old quote; the adjusted quote applies next tick.
        result.price_decision = market.update_price(firm);
        ++tick;
        total_money = household.money + firm.money;
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
                >> loaded.firm.money >> loaded.firm.inventory))
        throw std::runtime_error("invalid state: " + path);
    if (version == "economy-v2" || version == "economy-v3") {
        if (!(input >> loaded.household.stock >> loaded.household.needs))
            throw std::runtime_error("invalid state: " + path);
    } else if (version != "economy-v1") {
        throw std::runtime_error("invalid state: " + path);
    }
    if (version == "economy-v3") {
        if (!(input >> loaded.firm.price >> loaded.market.samples >> loaded.market.requested
              >> loaded.market.affordable >> loaded.market.sales >> loaded.market.unsold_ticks
              >> loaded.market.stockout_ticks >> loaded.market.last_reason))
            throw std::runtime_error("invalid market state: " + path);
    }
    // V1 had no stored household goods; migrate to stock=0, needs=2.
    if ((input >> extra)
        || loaded.tick < 0 || loaded.household.money < 0
        || loaded.household.money > 200 || loaded.firm.money < 0
        || loaded.firm.money != 200 - loaded.household.money
        || loaded.firm.inventory < 0 || loaded.firm.inventory > max_goods
        || loaded.household.stock < 0 || loaded.household.stock > max_goods
        || loaded.household.needs < 0 || loaded.household.needs > max_goods
        || loaded.firm.price < min_price || loaded.firm.price > max_price
        || loaded.market.samples < 0 || loaded.market.samples >= price_period
        || loaded.market.requested < 0 || loaded.market.requested > loaded.market.samples
        || loaded.market.affordable < 0 || loaded.market.affordable > loaded.market.requested
        || loaded.market.sales < 0 || loaded.market.sales > loaded.market.affordable
        || loaded.market.unsold_ticks < 0 || loaded.market.unsold_ticks > loaded.market.samples
        || loaded.market.stockout_ticks < 0 || loaded.market.stockout_ticks > loaded.market.affordable - loaded.market.sales
        || loaded.market.last_reason < 0 || loaded.market.last_reason > 6)
        throw std::runtime_error("invalid state: " + path);
    loaded.total_money = loaded.household.money + loaded.firm.money;
    economy = loaded;
}

void save(const Economy& economy, const std::string& path) {
    const std::string temporary = path + ".tmp";
    std::ofstream output(temporary, std::ios::trunc);
    output << "economy-v3 " << economy.tick << ' ' << economy.household.money
           << ' ' << economy.firm.money << ' ' << economy.firm.inventory
           << ' ' << economy.household.stock << ' ' << economy.household.needs
           << ' ' << economy.firm.price << ' ' << economy.market.samples
           << ' ' << economy.market.requested << ' ' << economy.market.affordable
           << ' ' << economy.market.sales << ' ' << economy.market.unsold_ticks
           << ' ' << economy.market.stockout_ticks << ' ' << economy.market.last_reason << '\n';
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
                  << " total_money=" << economy.total_money
                  << " inventory=" << economy.firm.inventory
                  << " household_stock=" << economy.household.stock
                  << " household_needs=" << economy.household.needs
                  << " purchased=" << (result.purchased ? 1 : 0)
                  << " produced=" << result.produced
                  << " consumed=" << (result.consumed ? 1 : 0)
                  << " unmet_need=" << (result.unmet_need ? 1 : 0)
                  << " price=" << result.trade_price << " next_price=" << economy.firm.price
                  << " requested=" << result.requested_goods << " affordable=" << result.affordable_goods
                  << " price_reason=" << price_reason(result.price_decision) << std::endl;
        return;
    }
    // Tick is a string to preserve 64-bit precision in JavaScript.
    std::cout << "{\"tick\":\"" << economy.tick << "\",\"household_money\":" << economy.household.money
              << ",\"firm_money\":" << economy.firm.money
              << ",\"inventory\":" << economy.firm.inventory
              << ",\"household_stock\":" << economy.household.stock
              << ",\"household_needs\":" << economy.household.needs
              << ",\"produced\":" << result.produced
              << ",\"purchased\":" << (result.purchased ? 1 : 0)
              << ",\"consumed\":" << (result.consumed ? 1 : 0)
              << ",\"unmet_need\":" << (result.unmet_need ? 1 : 0)
              << ",\"wage\":" << wage << ",\"price\":" << result.trade_price
              << ",\"next_price\":" << economy.firm.price
              << ",\"market\":{\"desired\":" << result.desired_goods
              << ",\"requested\":" << result.requested_goods
              << ",\"affordable\":" << result.affordable_goods
              << ",\"supply\":" << result.offered_goods
              << ",\"sales\":" << (result.purchased ? 1 : 0)
              << ",\"unfilled\":" << result.requested_goods - (result.purchased ? 1 : 0)
              << ",\"samples\":" << economy.market.samples
              << ",\"window_requested\":" << economy.market.requested
              << ",\"window_affordable\":" << economy.market.affordable
              << ",\"window_sales\":" << economy.market.sales
              << ",\"window_unsold\":" << economy.market.unsold_ticks
              << ",\"window_stockouts\":" << economy.market.stockout_ticks
              << ",\"last_reason\":\"" << price_reason(economy.market.last_reason)
              << "\",\"decision\":\"" << price_reason(result.price_decision)
              << "\",\"period\":" << price_period << ",\"min_price\":" << min_price
              << ",\"max_price\":" << max_price << "}"
              << ",\"production_batch\":" << production_batch
              << ",\"production_threshold\":" << production_threshold
              << ",\"total_money\":" << economy.total_money
              << ",\"before\":{\"household_money\":" << result.household_before
              << ",\"firm_money\":" << result.firm_before
              << ",\"inventory\":" << result.inventory_before
              << ",\"household_stock\":" << result.household_stock_before_trade
              << "},\"after_work\":{\"household_money\":" << result.household_after_work
              << ",\"firm_money\":" << result.firm_after_work
              << ",\"inventory\":" << result.inventory_after_work
              << ",\"household_stock\":" << result.household_stock_before_trade
              << "},\"after_trade\":{\"household_money\":" << economy.household.money
              << ",\"firm_money\":" << economy.firm.money
              << ",\"inventory\":" << economy.firm.inventory
              << ",\"household_stock\":" << result.household_stock_after_trade
              << "},\"after_consumption\":{\"household_stock\":" << result.household_stock_after_consumption
              << "},\"before_consumption\":{\"household_stock\":" << result.household_stock_before_consumption
              << "}}" << std::endl;
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
