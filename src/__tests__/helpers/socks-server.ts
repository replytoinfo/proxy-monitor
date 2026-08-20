import * as net from "node:net";

export interface FakeSocksOptions {
  /** Требовать метод user/pass (0x02) вместо no-auth. */
  requireAuth?: boolean;
  /** Верная пара; при несовпадении сервер отвечает отказом авторизации. */
  credentials?: { username: string; password: string };
  /** Код ответа на CONNECT: 0x00 — разрешено, 0x05 — connection refused. */
  connectReply?: number;
  /** Сырой HTTP-ответ, который сервер отдаёт в туннель. */
  response?: string;
}

export interface FakeSocksServer {
  port: number;
  /** Всё, что клиент записал в туннель. */
  lastRequest: () => string;
  close: () => Promise<void>;
}

/**
 * Минимальный SOCKS5-сервер: рукопожатие, необязательная авторизация,
 * настраиваемый ответ на CONNECT и заранее заготовленный HTTP-ответ в туннель.
 * Нужен, чтобы отличать «авторизация прошла» от «соединение разрешено»
 * без выхода в реальную сеть.
 */
export function startFakeSocks5(options: FakeSocksOptions = {}): Promise<FakeSocksServer> {
  const requireAuth = options.requireAuth ?? false;
  const connectReply = options.connectReply ?? 0x00;
  const response =
    options.response ?? "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7";

  let lastRequest = "";

  const server = net.createServer((socket) => {
    let stage: "greeting" | "auth" | "connect" | "tunnel" = "greeting";
    let buf = Buffer.alloc(0);

    socket.on("error", () => {
      // Клиент рвёт соединение первым — для теста это нормально.
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === "greeting") {
        if (buf.length < 2) return;
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;
        const methods = Array.from(buf.subarray(2, 2 + nMethods));
        buf = buf.subarray(2 + nMethods);

        if (requireAuth) {
          if (!methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, 0x02]));
          stage = "auth";
        } else {
          socket.write(Buffer.from([0x05, 0x00]));
          stage = "connect";
        }
      }

      if (stage === "auth") {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;

        const username = buf.subarray(2, 2 + ulen).toString();
        const password = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);

        const ok =
          !options.credentials ||
          (username === options.credentials.username &&
            password === options.credentials.password);

        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) {
          socket.end();
          return;
        }
        stage = "connect";
      }

      if (stage === "connect") {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const addrLen = atyp === 0x03 ? 1 + buf[4] : atyp === 0x01 ? 4 : 16;
        const total = 4 + addrLen + 2;
        if (buf.length < total) return;
        buf = buf.subarray(total);

        socket.write(Buffer.from([0x05, connectReply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (connectReply !== 0x00) {
          socket.end();
          return;
        }
        stage = "tunnel";
      }

      if (stage === "tunnel") {
        lastRequest += buf.toString();
        buf = Buffer.alloc(0);
        if (lastRequest.includes("\r\n\r\n")) {
          socket.write(response);
          socket.end();
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        lastRequest: () => lastRequest,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
