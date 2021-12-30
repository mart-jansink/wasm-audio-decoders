import OpusDecodedAudio from "./OpusDecodedAudio.js";
import EmscriptenWasm from "./EmscriptenWasm.js";

let wasm;
export default class OggOpusDecoder {
  constructor(_OpusDecodedAudio, _EmscriptenWasm) {
    this._ready = this._init(_OpusDecodedAudio, _EmscriptenWasm);
  }

  static concatFloat32(buffers, length) {
    const ret = new Float32Array(length);

    let offset = 0;
    for (const buf of buffers) {
      ret.set(buf, offset);
      offset += buf.length;
    }

    return ret;
  }

  // creates a Float32Array on the Wasm heap and returns it and its pointer
  _allocateTypedArray(length, TypedArray) {
    const pointer = this._wasm._malloc(TypedArray.BYTES_PER_ELEMENT * length);
    const array = new TypedArray(this._wasm.HEAP, pointer, length);
    return [pointer, array];
  }

  // injects dependencies when running as a web worker
  async _init(_OpusDecodedAudio, _EmscriptenWasm) {
    if (!this._wasm) {
      const isWebWorker = _OpusDecodedAudio && _EmscriptenWasm;

      if (isWebWorker) {
        // use classes injected into the constructor parameters
        this._OpusDecodedAudio = _OpusDecodedAudio;
        this._EmscriptenWasm = _EmscriptenWasm;

        // running as a webworker: compile the Wasm per decoder instance
        this._wasm = new this._EmscriptenWasm();
      } else {
        // use classes from ES6 imports
        this._OpusDecodedAudio = OpusDecodedAudio;
        this._EmscriptenWasm = EmscriptenWasm;

        // use a global scope singleton so the Wasm compilation happens once
        // only when the first decoder instance is instantiated
        if (!wasm) {
          wasm = new this._EmscriptenWasm();
        }
        this._wasm = wasm;
      }
    }

    await this._wasm.ready;

    this._decoder = this._wasm._ogg_opus_decoder_create();

    // input: data to send per iteration, 64 KB is the maximum for enqueuing in
    // libopusfile
    [this._inputPtr, this._input] = this._allocateTypedArray(
      (64 * 1024),
      Uint8Array
    );

    // output: 120ms buffer @ 48 kHz recommended per http://opus-codec.org/docs/
    // opusfile_wasm-0.7/group__stream__decoding.html
    [this._leftPtr, this._leftArr] = this._allocateTypedArray(
      (120 * 48),
      Float32Array
    );
    [this._rightPtr, this._rightArr] = this._allocateTypedArray(
      (120 * 48),
      Float32Array
    );
  }

  get ready() {
    return this._ready;
  }

  async reset() {
    this.free();
    await this._init();
  }

  free() {
    this._wasm._ogg_opus_decoder_free(this._decoder);

    this._wasm._free(this._inputPtr);
    this._wasm._free(this._leftPtr);
    this._wasm._free(this._rightPtr);
  }

  /*
    WARNING: When decoding chained Ogg files (i.e. streaming) the first two Ogg
    packets of the next chain must be present when decoding. Errors will be
    returned by libopusfile if these initial Ogg packets are incomplete.
  */
  decode(data) {
    if (!(data instanceof Uint8Array))
      throw Error(
        `Data to decode must be Uint8Array. Instead got "${typeof data}".`
      );

    let decodedLeft = [],
      decodedRight = [],
      samplesDecoded = 0,
      offset = 0;

    while (offset < data.length) {
      const dataToSend = data.subarray(
        offset,
        offset + Math.min(this._input.length, data.length - offset)
      );
      offset += dataToSend.length;
      this._input.set(dataToSend);

      // enqueue bytes to decode and fail on any error
      if (!this._wasm._ogg_opus_decoder_enqueue(
        this._decoder,
        this._inputPtr,
        dataToSend.length
      )) {
        throw Error(
          "Could not enqueue bytes for decoding. You may also have invalid Ogg Opus file."
        );
      }

      // continue to decode until no more bytes are left to decode
      let iterationResult;
      while (
        (iterationResult = this._wasm._ogg_opus_decode_float_stereo_deinterleaved(
          this._decoder,
          this._leftPtr, // left channel
          this._rightPtr // right channel
        )) > 0
      ) {
        decodedLeft.push(this._leftArr.slice(0, iterationResult));
        decodedRight.push(this._rightArr.slice(0, iterationResult));
        samplesDecoded += iterationResult;
      }

      // prettier-ignore
      if (iterationResult < 0) {
        const errors = {
          [-1]: "A request did not succeed.",
          [-3]: "There was a hole in the page sequence numbers (e.g., a page was corrupt or missing).",
          [-128]: "An underlying read, seek, or tell operation failed when it should have succeeded.",
          [-129]: "A NULL pointer was passed where one was unexpected, or an internal memory allocation failed, or an internal library error was encountered.",
          [-130]: "The stream used a feature that is not implemented, such as an unsupported channel family.",
          [-131]: "One or more parameters to a function were invalid.",
          [-132]: "A purported Ogg Opus stream did not begin with an Ogg page, a purported header packet did not start with one of the required strings, \"OpusHead\" or \"OpusTags\", or a link in a chained file was encountered that did not contain any logical Opus streams.",
          [-133]: "A required header packet was not properly formatted, contained illegal values, or was missing altogether.",
          [-134]: "The ID header contained an unrecognized version number.",
          [-136]: "An audio packet failed to decode properly. This is usually caused by a multistream Ogg packet where the durations of the individual Opus packets contained in it are not all the same.",
          [-137]: "We failed to find data we had seen before, or the bitstream structure was sufficiently malformed that seeking to the target destination was impossible.",
          [-138]: "An operation that requires seeking was requested on an unseekable stream.",
          [-139]: "The first or last granule position of a link failed basic validity checks.",
        }
  
        throw new Error(
          `libopusfile ${iterationResult}: ${
            errors[iterationResult] || "Unknown error."
          }`
        );
      }
    }

    return new this._OpusDecodedAudio(
      [
        OggOpusDecoder.concatFloat32(decodedLeft, samplesDecoded),
        OggOpusDecoder.concatFloat32(decodedRight, samplesDecoded),
      ],
      samplesDecoded
    );
  }
}
