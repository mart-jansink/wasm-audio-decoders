import Worker from "web-worker";

import EmscriptenWasm from "./EmscriptenWasm.js";
import OpusDecodedAudio from "./OpusDecodedAudio.js";
import OggOpusDecoder from "./OggOpusDecoder.js";

const sourceURLs = new Map();
export default class OggOpusDecoderWebWorker extends Worker {
  constructor(channels = 2) {
    if (!sourceURLs.has(channels)) {
      const webworkerSourceCode =
        "'use strict';" +
        // dependencies need to be manually resolved when stringifying this
        `(${((channels, _OggOpusDecoder, _OpusDecodedAudio, _EmscriptenWasm) => {
          // we're in a Web Worker: inject the classes to compile the Wasm per
          // decoder instance
          const decoder = new _OggOpusDecoder(
            channels,
            _OpusDecodedAudio,
            _EmscriptenWasm
          );

          self.onmessage = ({ data: { id, command, oggOpusData } }) => {
            switch (command) {
              case "ready":
                decoder.ready.then(() => {
                  self.postMessage({
                    id,
                  });
                });
                break;

              case "free":
                decoder.free();
                self.postMessage({
                  id,
                });
                break;

              case "reset":
                decoder.reset().then(() => {
                  self.postMessage({
                    id,
                  });
                });
                break;

              case "decode":
                const { channelData, samplesDecoded, sampleRate } = decoder.decode(
                  new Uint8Array(oggOpusData)
                );

                // the "transferList" parameter transfers ownership of channel
                // data to main thread, which avoids copying memory
                self.postMessage( {
                  id,
                  channelData,
                  samplesDecoded,
                  sampleRate,
                }, channelData.map((channel) => channel.buffer));
                break;

              default:
                this.console.error(
                  "Unknown command sent to worker: " + command
                );
            }
          };
        }).toString()})(${channels}, ${OggOpusDecoder}, ${OpusDecodedAudio}, ${EmscriptenWasm})`;

      const type = "text/javascript";
      try {
        // browser
        sourceURLs.set(channels, URL.createObjectURL(
          new Blob([webworkerSourceCode], { type })
        ));
      } catch {
        // node.js
        sourceURLs.set(channels, `data:${type};base64,${Buffer.from(
          webworkerSourceCode
        ).toString("base64")}`);
      }
    }

    super(sourceURLs.get(channels));

    this._id = Number.MIN_SAFE_INTEGER;
    this._enqueuedOperations = new Map();

    this.onmessage = ({ data }) => {
      this._enqueuedOperations.get(data.id)(data);
      this._enqueuedOperations.delete(data.id);
    };
  }

  async _postToDecoder(command, oggOpusData) {
    return new Promise((resolve) => {
      this.postMessage({
        command,
        id: this._id,
        oggOpusData,
      });

      this._enqueuedOperations.set(this._id++, resolve);
    });
  }

  get ready() {
    return this._postToDecoder("ready");
  }

  async free() {
    await this._postToDecoder("free").finally(() => {
      this.terminate();
    });
  }

  async reset() {
    await this._postToDecoder("reset");
  }

  async decode(data) {
    const { channelData, samplesDecoded } = await this._postToDecoder("decode", data);
    return new OpusDecodedAudio(channelData, samplesDecoded);
  }
}
