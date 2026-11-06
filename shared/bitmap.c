#include "bitmap.h"

static size_t row_bytes(int width) { return (size_t)(width + 1) / 2; }

void plugin_bitmap_free(PluginBitmap *image) {
  if (image->bitmap) { gbitmap_destroy(image->bitmap); }
  free(image->pixels);
  memset(image, 0, sizeof(*image));
}

void plugin_bitmap_begin(PluginBitmap *image, int width, int height, const uint8_t *palette, size_t palette_count) {
  plugin_bitmap_free(image);
  if (width <= 0 || height <= 0 || width > 260 || height > 260) { return; }
  image->width = width;
  image->height = height;
  image->palette_count = palette_count > 16 ? 16 : (int)palette_count;
  if (palette) { memcpy(image->palette, palette, image->palette_count); }
  image->pixels = calloc(row_bytes(width) * height, 1);
}

void plugin_bitmap_add(PluginBitmap *image, int offset, const uint8_t *data, size_t length) {
  size_t total = row_bytes(image->width) * image->height;
  if (!image->pixels || offset < 0 || (size_t)offset + length > total) { return; }
  memcpy(image->pixels + offset, data, length);
  image->received += length;
}

#if !defined(PBL_COLOR)
static int index_at(PluginBitmap *image, int x, int y) {
  uint8_t byte = image->pixels[y * row_bytes(image->width) + x / 2];
  return x % 2 ? byte & 0x0F : byte >> 4;
}
#endif

GBitmap *plugin_bitmap_get(PluginBitmap *image) {
  if (image->bitmap) { return image->bitmap; }
  if (!image->pixels || image->received < row_bytes(image->width) * image->height) { return NULL; }
  GSize size = GSize(image->width, image->height);
#if defined(PBL_COLOR)
  GColor *palette = malloc(16 * sizeof(GColor));
  if (!palette) { return NULL; }
  for (int i = 0; i < 16; i++) {
    palette[i] = (GColor){ .argb = i < image->palette_count ? image->palette[i] : 0 };
  }
  image->bitmap = gbitmap_create_blank_with_palette(size, GBitmapFormat4BitPalette, palette, true);
  if (!image->bitmap) { free(palette); return NULL; }
  uint8_t *data = gbitmap_get_data(image->bitmap);
  uint16_t stride = gbitmap_get_bytes_per_row(image->bitmap);
  for (int y = 0; y < image->height; y++) {
    memcpy(data + y * stride, image->pixels + y * row_bytes(image->width), row_bytes(image->width));
  }
#else
  image->bitmap = gbitmap_create_blank(size, GBitmapFormat1Bit);
  if (!image->bitmap) { return NULL; }
  uint8_t *data = gbitmap_get_data(image->bitmap);
  uint16_t stride = gbitmap_get_bytes_per_row(image->bitmap);
  for (int y = 0; y < image->height; y++) {
    for (int x = 0; x < image->width; x++) {
      int index = index_at(image, x, y);
      uint8_t argb = index < image->palette_count ? image->palette[index] : 0;
      // Brightness out of 9 from the three 2-bit channels. Only near
      // white stays white: the plugin's pictures are white or black on a
      // coloured disc, and the disc has to come out dark for the picture
      // to show. Transparent takes the ground's colour.
      int light = ((argb >> 4) & 3) + ((argb >> 2) & 3) + (argb & 3);
      bool white = (argb >> 6) != 3 ? !image->dark_ground : light >= 8;
      if (white) { data[y * stride + x / 8] |= 1 << (x % 8); }
    }
  }
#endif
  free(image->pixels);
  image->pixels = NULL;
  return image->bitmap;
}

void plugin_bitmap_draw(GContext *ctx, PluginBitmap *image, GPoint origin) {
  GBitmap *bitmap = plugin_bitmap_get(image);
  if (!bitmap) { return; }
  graphics_context_set_compositing_mode(ctx, PBL_IF_COLOR_ELSE(GCompOpSet, GCompOpAssign));
  graphics_draw_bitmap_in_rect(ctx, bitmap, GRect(origin.x, origin.y, image->width, image->height));
}
