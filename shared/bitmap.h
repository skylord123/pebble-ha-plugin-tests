/*
 * A plugin's `icon` or `image` shape, as it arrives from the phone in
 * pieces: 4 bits a pixel, two pixels a byte with the even column in the
 * high nibble, rows padded to whole bytes, and a palette of Pebble colours
 * (0b11rrggbb opaque, 0 transparent).
 *
 * Colour watches draw it as it is. Aplite has no palettes, so there each
 * pixel becomes black or white by how dark its colour is, and transparent
 * takes the colour of the ground it is drawn on (`dark_ground`).
 *
 * Shared by both apps: each one's src/c/bitmap.* links here.
 */
#pragma once
#include <pebble.h>

typedef struct {
  int width;
  int height;
  uint8_t palette[16];
  int palette_count;
  uint8_t *pixels;
  size_t received;
  GBitmap *bitmap;
  //! Set after plugin_bitmap_begin when drawing on black, for aplite
  bool dark_ground;
} PluginBitmap;

void plugin_bitmap_begin(PluginBitmap *image, int width, int height, const uint8_t *palette, size_t palette_count);
void plugin_bitmap_add(PluginBitmap *image, int offset, const uint8_t *data, size_t length);
//! The finished bitmap, or NULL until every pixel has arrived
GBitmap *plugin_bitmap_get(PluginBitmap *image);
void plugin_bitmap_draw(GContext *ctx, PluginBitmap *image, GPoint origin);
void plugin_bitmap_free(PluginBitmap *image);
