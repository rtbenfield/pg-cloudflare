import { connect } from "cloudflare:sockets";
import { Duplex } from "node:stream";

/**
 * Wrapper around the Cloudflare built-in socket that can be used by the `Connection`.
 *
 * This is an alternative implementation to the `pg-cloudflare` package
 * that exists in the `pg` GitHub repository. The original version does not
 * inherit from `Duplex` and instead implements a minimal API surface area as
 * needed for compatibility with `pg`. Unfortunately, this leads to some
 * extended use cases, like `pg-copy-streams`, being unsupported.
 *
 * This version builds on `Duplex` and implements pull-based streaming. It
 * supports use cases like `pg-copy-streams` that rely on the stream to apply
 * backpressure to the underlying socket. It also addresses a few edge cases
 * around the socket lifecycle which are called out in the comments.
 */
export class CloudflareSocket extends Duplex {
  /** The active Socket instance, if there is one. */
  #cfSocket: Socket | null = null;
  /** A reader handle to the active socket, if there is one. */
  #cfReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** A writer handle to the active socket, if there is one. */
  #cfWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** Indicates whether the socket is in the process of upgrading to TLS. */
  #upgrading: boolean = false;
  /** Indicates whether the socket has been upgraded to TLS. */
  #upgraded: boolean = false;

  constructor(readonly ssl: boolean) {
    super({
      // treat values streamed as objects rather than binary data
      // this preserves PostgreSQL data frames
      objectMode: true,
      destroy: (error, cb) => {
        log("destroying CF socket", error);
        if (!this.#cfSocket) {
          // nothing to do, just call the callback
          cb(error);
        } else {
          // close the underlying socket
          this.#cfSocket
            .close()
            .then(() => cb(error))
            .catch((error) => cb(error));
        }
      },
      read: () => {
        log("read");
        this.#cfReader!.read()
          .then((result) => {
            if (result.done) {
              // connection was closed by the server
              log("read done");
              //! reset #cfSocket as close() will never resolve now
              this.#cfSocket = null;
              this.#cfReader = null;
              this.#cfWriter = null;
              this.push(null);
            } else {
              log("read data", result.value);
              // the connectin consumer wants a Buffer because Node
              this.push(Buffer.from(result.value));
            }
          })
          .catch((error) => {
            log("read error", error);
            // any error during the read should just bail on the connection
            this.destroy(error);
          });
      },
      write: (data, encoding = "utf-8", callback = () => {}) => {
        if (data.length === 0) return callback();
        if (typeof data === "string") data = Buffer.from(data, encoding);
        log("sending data direct:", data);
        this.#cfWriter!.write(data)
          .then(() => {
            log("data sent");
            callback();
          })
          .catch((err) => {
            log("send error", err);
            callback(err);
          });
        return true;
      },
    });
  }

  override end(cb?: () => void): this;
  override end(chunk: unknown, cb?: () => void): this;
  override end(
    chunk: unknown,
    encoding?: BufferEncoding,
    cb?: () => void,
  ): this;
  override end(...args: unknown[]): this {
    log("ending CF socket");
    // @ts-ignore
    super.end(...args);
    // we need to sometimes close the socket manually or it will hang forever
    // Duplex.end() would normally leave it half open which we don't want here
    void this.#cfSocket?.close();
    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  async connect(
    port: number,
    hostname: string,
    connectListener?: (...args: unknown[]) => void,
  ) {
    try {
      log("connecting");
      if (connectListener) this.once("connect", connectListener);
      this.#cfSocket = connect(
        { hostname, port },
        {
          allowHalfOpen: false,
          secureTransport: this.ssl ? "starttls" : "off",
        },
      );
      this._addClosedHandler();
      this.#cfWriter = this.#cfSocket.writable.getWriter();
      this.#cfReader = this.#cfSocket.readable.getReader();
      await this.#cfSocket.opened;
      log("socket ready");
      this.emit("connect");
    } catch (e) {
      log("connect failed", e);
      this.emit("error", e);
    }
    return this;
  }

  startTls(options: TlsOptions) {
    if (this.#upgraded) {
      // Don't try to upgrade again.
      this.emit("error", "Cannot call `startTls()` more than once on a socket");
      return;
    }
    this.#upgrading = true;
    this.#cfWriter?.releaseLock();
    this.#cfReader?.releaseLock();
    this.#cfSocket = this.#cfSocket!.startTls(options);
    // TODO: it would be helpful to check that the new socket opens successfully
    // Socket.opened on the new socket never resolves
    this.#cfWriter = this.#cfSocket.writable.getWriter();
    this.#cfReader = this.#cfSocket.readable.getReader();
    this._addClosedHandler();
  }

  _addClosedHandler() {
    this.#cfSocket!.closed.then(() => {
      if (!this.#upgrading) {
        //! the socket may close unexpectedly if an untrusted certificate is used
        // this is difficult to detect since Socket.opened never resolves
        log("CF socket closed");
        this.#cfSocket = null;
        this.#cfReader = null;
        this.#cfWriter = null;
        this.destroy();
      } else {
        // this is the old, non-TLS socket cleaning itself up
        log("CF socket upgraded");
        this.#upgrading = false;
        this.#upgraded = true;
      }
    }).catch((e) => this.emit("error", e));
  }
}

const debug = false;

function dump(data: unknown) {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    const hex = Buffer.from(data).toString("hex");
    const str = new TextDecoder().decode(data);
    return `\n>>> STR: "${str.replace(/\n/g, "\\n")}"\n>>> HEX: ${hex}\n`;
  } else {
    return data;
  }
}

function log(...args: unknown[]) {
  debug && console.log(...args.map(dump));
}
