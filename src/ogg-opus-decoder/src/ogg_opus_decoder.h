#include <stdlib.h>
#include <string.h>
#include <opusfile.h>

typedef struct {
  /*
    WARNING: Data should be large enough to maximum Ogg page size for
    instantiating OggOpusFile. See https://xiph.org/ogg/doc/oggstream.html:
    "...pages are a maximum of just under 64kB". Tested with 512kbps Opus file
    whose first data page ended at 54880 bytes.
  */
  unsigned char _data[64*1024];

  // *start is first position of _data, *cursor moves as reads occur
  unsigned char *start, *cursor;

  // this tracks the number of unread bytes in the buffer, increases when bytes
  // are enqueued, decreases when they are decoded
  int num_unread;
} ByteBuffer;

typedef struct {
  OpusFileCallbacks cb;
  OggOpusFile *of;
  ByteBuffer buffer;

  // 120ms buffer @ 48 kHz recommended per http://opus-codec.org/docs/opusfile_w
  // asm-0.7/group__stream__decoding.html
  float pcm[120*48*2];
} OggOpusDecoder;

OggOpusDecoder *ogg_opus_decoder_create();

void ogg_opus_decoder_free(OggOpusDecoder *);

int ogg_opus_decoder_enqueue(OggOpusDecoder *, unsigned char *data, size_t data_size);

int ogg_opus_decode_float_stereo_deinterleaved(OggOpusDecoder *decoder, float *left, float *right);
