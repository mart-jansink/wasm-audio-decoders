#include "ogg_opus_decoder.h"

static int cb_read(OggOpusDecoder *decoder, unsigned char *_ptr, int _nbytes) {
  // don't read from buffer if OggOpusFile not instantiated yet
  if (!decoder->of) return 0;

  // don't read more than what's available to read
  if (_nbytes > decoder->buffer.num_unread) {
    _nbytes = decoder->buffer.num_unread;
  }

  // fprintf(stderr, "cb_read, _nbytes %i, queued %6i\n", _nbytes, decoder->buffer.num_unread);

  if (_nbytes) {
    memcpy(_ptr, decoder->buffer.cursor, _nbytes);

    decoder->buffer.cursor += _nbytes;
    decoder->buffer.num_unread -= _nbytes;

    // fwrite(_ptr, sizeof(*_ptr), _nbytes, outfile_rewrite);
  }
  // cb_read_total_bytes += _nbytes;
  return _nbytes;
}

/*
 * Feed opus audio data for decoding. Calling program should enqueue and decode
 * immediately after enqueuing to reduce decoding latency and reduce size of
 * undecoded decoder->buffer data. Per https://xiph.org/ogg/doc/oggstream.html,
 * decoding would be possible by 64k. Otherwise, you're feeding invalid Opus
 * data that is not recognized as a valid, decodeable Ogg Opus File
 *
 * The undecoded 64k buffer won't overflow and this method succeeds if:
 *   1) You enqueue bytes in sizes that are divisors of 64 (64, 32, 16, etc)
 *   2) You enqueue valid Opus audio data that can be decoded
 *   3) You decode data after enqueuing it (thus removing it from unread buffer)
 *
 * Returns 1 or 0 for success or error
 */
int ogg_opus_decoder_enqueue(OggOpusDecoder *decoder, unsigned char *data, size_t size) {
  ssize_t bufferMax = sizeof(decoder->buffer._data),
      bufferUsed = decoder->buffer.num_unread;

  // fprintf(stdout, "Undecoded: %zd\n", bufferUsed);

  if (bufferUsed + size > bufferMax) {
    /*fprintf(stderr, "ERROR: Cannot enqueue %zd bytes, overflows by %zd. Used: "\
                    "%zd/%zd, OggOpusFile discovered: %s. " \
                    "Try reducing chunk or decode before enqueuing more\n",
      size,
      size + bufferUsed - bufferMax,
      bufferUsed,
      bufferMax,
      (!decoder->of)? "false" : "true"
    );*/
    return 0;
  }

  decoder->buffer.cursor = decoder->buffer.start;

  // initialize OggOpusFile if not yet initialized; a few attempts might be
  // needed until enough bytes are collected for it to discover first Ogg page
  if (!decoder->of) {
    memcpy(decoder->buffer.cursor + decoder->buffer.num_unread, data, size);
    decoder->buffer.num_unread += size;

    int err;

    decoder->of = op_open_callbacks(
      decoder,
      &decoder->cb,
      decoder->buffer.cursor,
      decoder->buffer.num_unread,
      &err
    );

    if (err == 0) {
      //fprintf(stderr, "OggOpusFile discovered with %d bytes\n", decoder->buffer.num_unread);

      // OggOpusFile instantiated, reset unread buffer count
      decoder->buffer.num_unread = 0;
    }
  } else {
    // set buffer to new data
    decoder->buffer.num_unread += size;
    memcpy(decoder->buffer.cursor, data, size);
  }

  return 1;
}

int ogg_opus_decode_float_deinterleaved(OggOpusDecoder *decoder, int channels, float *l, float *c, float *r, float *ls, float *rs, float *lr, float *rr, float *lfe) {
  if (!decoder->of) return 0;

  int samples_decoded = op_read_float(decoder->of, decoder->pcm, 120*48*channels, NULL);
  float* output[8] = {l, c, r, ls, rs, lr, rr, lfe};

  for (int i=0; i<samples_decoded; ++i) {
    for (int c=0; c<channels; ++c) {
      output[c][i] = decoder->pcm[i*channels+c];
    }
  }

  return samples_decoded;
}

int ogg_opus_decode_float_stereo_deinterleaved(OggOpusDecoder *decoder, float *l, float *r) {
  if (!decoder->of) return 0;

  int samples_decoded = op_read_float_stereo(decoder->of, decoder->pcm, 120*48*2);

  for (int i=0; i<samples_decoded; ++i) {
    l[i] = decoder->pcm[i*2+0];
    r[i] = decoder->pcm[i*2+1];
  }

  return samples_decoded;
}

void ogg_opus_decoder_free(OggOpusDecoder *decoder) {
  op_free(decoder->of);
  free(decoder);
}

static ByteBuffer create_bytebuffer() {
  ByteBuffer cb;
  cb.start = cb._data;
  cb.cursor = cb._data;
  cb.num_unread = 0;
  return cb;
}

OggOpusDecoder *ogg_opus_decoder_create() {
  OggOpusDecoder decoder;
  decoder.cb.read = (int (*)(void *, unsigned char *, int))cb_read;
  decoder.cb.seek = NULL;
  decoder.cb.tell = NULL;
  decoder.cb.close = NULL;
  decoder.of = NULL;
  decoder.buffer = create_bytebuffer();

  OggOpusDecoder *ptr = malloc(sizeof(decoder));
  *ptr = decoder;
  return ptr;
}
