FROM gcc:14 AS build
WORKDIR /app
COPY src/main.cpp .
RUN g++ -std=c++17 -O2 -Wall -Wextra -Wpedantic -pthread main.cpp -o economy

FROM debian:bookworm-slim
RUN useradd --uid 10001 --create-home simulation && mkdir /data && chown simulation /data
COPY --from=build /app/economy /usr/local/bin/economy
USER simulation
VOLUME /data
ENTRYPOINT ["economy"]
CMD ["--forever", "--interval-ms", "1000", "--state", "/data/economy.state"]
