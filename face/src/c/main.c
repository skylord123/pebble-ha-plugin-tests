/*
 * HA Plugin Face: the time, and Home Assistant's weather and a couple of
 * shared entities as the Home Assistant WS plugin serves them.
 *
 * The phone reads the plugin (src/pkjs/index.js) and sends finished lines
 * of text, plus the condition picture as the plugin drew it. The face only
 * keeps the time itself.
 */
#include <pebble.h>

#include "bitmap.h"

static Window *s_window;
static TextLayer *s_time, *s_date, *s_temp, *s_cond, *s_hilo, *s_hours, *s_ent1, *s_ent2;
static Layer *s_icon_layer;
static PluginBitmap s_icon;
static int s_icon_size;

static char s_time_text[8], s_date_text[24];
static char s_place[32], s_temp_text[16], s_cond_text[40], s_err[64], s_cond_line[80];
static char s_hilo_text[48], s_hours_text[48], s_ent1_text[48], s_ent2_text[48];

static TextLayer *line(Layer *root, GRect frame, const char *font) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, GColorWhite);
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_alignment(layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(layer, GTextOverflowModeTrailingEllipsis);
  layer_add_child(root, text_layer_get_layer(layer));
  return layer;
}

static void update_time(void) {
  time_t now = time(NULL);
  struct tm *t = localtime(&now);
  strftime(s_time_text, sizeof(s_time_text), clock_is_24h_style() ? "%H:%M" : "%I:%M", t);
  strftime(s_date_text, sizeof(s_date_text), "%a %b %e", t);
  text_layer_set_text(s_time, s_time_text[0] == '0' && !clock_is_24h_style() ? s_time_text + 1 : s_time_text);
  text_layer_set_text(s_date, s_date_text);
}

static void tick(struct tm *t, TimeUnits changed) { update_time(); }

static void show_condition(void) {
  // An error from the plugin is worth more than a stale condition
  if (s_err[0]) {
    snprintf(s_cond_line, sizeof(s_cond_line), "%s", s_err);
    text_layer_set_text_color(s_cond, PBL_IF_COLOR_ELSE(GColorMelon, GColorWhite));
  } else {
    snprintf(s_cond_line, sizeof(s_cond_line), "%s%s%s", s_cond_text, s_place[0] ? " · " : "", s_place);
    text_layer_set_text_color(s_cond, GColorWhite);
  }
  text_layer_set_text(s_cond, s_cond_line);
}

static void draw_icon(Layer *layer, GContext *ctx) {
  if (!plugin_bitmap_get(&s_icon)) { return; }
  plugin_bitmap_draw(ctx, &s_icon, GPoint(0, 0));
}

static void copy_tuple(DictionaryIterator *in, uint32_t key, char *out, size_t size, TextLayer *layer) {
  Tuple *t = dict_find(in, key);
  if (!t) { return; }
  snprintf(out, size, "%s", t->value->cstring);
  if (layer) { text_layer_set_text(layer, out); }
}

static void inbox_received(DictionaryIterator *in, void *context) {
  copy_tuple(in, MESSAGE_KEY_place, s_place, sizeof(s_place), NULL);
  copy_tuple(in, MESSAGE_KEY_temp, s_temp_text, sizeof(s_temp_text), s_temp);
  copy_tuple(in, MESSAGE_KEY_cond, s_cond_text, sizeof(s_cond_text), NULL);
  copy_tuple(in, MESSAGE_KEY_err, s_err, sizeof(s_err), NULL);
  copy_tuple(in, MESSAGE_KEY_hilo, s_hilo_text, sizeof(s_hilo_text), s_hilo);
  copy_tuple(in, MESSAGE_KEY_hours, s_hours_text, sizeof(s_hours_text), s_hours);
  copy_tuple(in, MESSAGE_KEY_ent1, s_ent1_text, sizeof(s_ent1_text), s_ent1);
  copy_tuple(in, MESSAGE_KEY_ent2, s_ent2_text, sizeof(s_ent2_text), s_ent2);
  show_condition();

  Tuple *width = dict_find(in, MESSAGE_KEY_iconW);
  if (width) {
    Tuple *palette = dict_find(in, MESSAGE_KEY_iconPal);
    plugin_bitmap_begin(&s_icon, width->value->int32, dict_find(in, MESSAGE_KEY_iconH)->value->int32,
                        palette ? palette->value->data : NULL, palette ? palette->length : 0);
    s_icon.dark_ground = true;
  }
  Tuple *pixels = dict_find(in, MESSAGE_KEY_iconPx);
  if (pixels) {
    Tuple *offset = dict_find(in, MESSAGE_KEY_iconOff);
    plugin_bitmap_add(&s_icon, offset ? offset->value->int32 : 0, pixels->value->data, pixels->length);
    layer_mark_dirty(s_icon_layer);
  }
}

static void say_ready(void *context) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    app_timer_register(500, say_ready, NULL);
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_ready, 1);
  dict_write_int32(out, MESSAGE_KEY_iconSize, s_icon_size);
  dict_write_int32(out, MESSAGE_KEY_color, PBL_IF_COLOR_ELSE(1, 0));
  app_message_outbox_send();
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  bool tall = b.size.h >= 200;
  int w = b.size.w;
  int inset = PBL_IF_ROUND_ELSE(14, 0);
  s_icon_size = tall ? 52 : 40;

  int y = PBL_IF_ROUND_ELSE(8, 0);
  s_time = line(root, GRect(0, y - 6, w, 50), FONT_KEY_BITHAM_42_BOLD);
  y += 42;
  s_date = line(root, GRect(0, y - 2, w, 20), FONT_KEY_GOTHIC_18);
  y += 18;

  // The picture and the temperature side by side, centred together
  s_icon_layer = layer_create(GRect(w / 2 - s_icon_size - 2, y, s_icon_size, s_icon_size));
  layer_set_update_proc(s_icon_layer, draw_icon);
  layer_add_child(root, s_icon_layer);
  s_temp = line(root, GRect(w / 2 + 2, y + (s_icon_size - 34) / 2, w / 2 - 2, 34), FONT_KEY_GOTHIC_28_BOLD);
  text_layer_set_text_alignment(s_temp, GTextAlignmentLeft);
  y += s_icon_size;

  s_cond = line(root, GRect(inset, y - 2, w - 2 * inset, 20), FONT_KEY_GOTHIC_18_BOLD);
  y += 18;
  s_hilo = line(root, GRect(inset, y, w - 2 * inset, 18), FONT_KEY_GOTHIC_14);
  y += 15;
  // The circle closes in towards the bottom of a round screen
  int lower = PBL_IF_ROUND_ELSE(30, 0);
  s_hours = line(root, GRect(inset + lower / 2, y, w - 2 * inset - lower, 18), FONT_KEY_GOTHIC_14);
  y += 15;
  s_ent1 = line(root, GRect(inset + lower, y, w - 2 * (inset + lower), 18), FONT_KEY_GOTHIC_14);
  y += 15;
  s_ent2 = line(root, GRect(inset + 20, y, w - 2 * inset - 40, 18), FONT_KEY_GOTHIC_14);
  layer_set_hidden(text_layer_get_layer(s_ent2), y + 16 > b.size.h);

  text_layer_set_text(s_temp, "--");
  snprintf(s_cond_text, sizeof(s_cond_text), "Waiting for phone");
  show_condition();
  update_time();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_time);
  text_layer_destroy(s_date);
  text_layer_destroy(s_temp);
  text_layer_destroy(s_cond);
  text_layer_destroy(s_hilo);
  text_layer_destroy(s_hours);
  text_layer_destroy(s_ent1);
  text_layer_destroy(s_ent2);
  layer_destroy(s_icon_layer);
  plugin_bitmap_free(&s_icon);
}

int main(void) {
  s_window = window_create();
  window_set_background_color(s_window, PBL_IF_COLOR_ELSE(GColorOxfordBlue, GColorBlack));
  window_set_window_handlers(s_window, (WindowHandlers) { .load = window_load, .unload = window_unload });
  window_stack_push(s_window, true);
  tick_timer_service_subscribe(MINUTE_UNIT, tick);
  app_message_register_inbox_received(inbox_received);
  app_message_open(PBL_IF_COLOR_ELSE(2048, 1024), 64);
  app_timer_register(300, say_ready, NULL);
  app_event_loop();
  window_destroy(s_window);
}
