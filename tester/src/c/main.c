/*
 * HA Plugin Tester, the watch half.
 *
 * The watch only draws what the phone sends it: menus, scrolling text,
 * bitmaps and number selectors, each on its own screen with an id.
 * Everything about the plugin lives in src/pkjs/index.js. Picking a row,
 * holding select on it, dialling or setting a number and leaving a screen
 * are reported back with the screen's id.
 */
#include <pebble.h>

#include "bitmap.h"

#define MAX_DEPTH 8
#define MAX_ROWS 64
#define STATUS_MS 5000

// The number selector's timings, the same as the Home Assistant WS app's
// (src/simply/simply_number.c there). Repeat cadence while a button is held,
// and how many repeats before the step multiplier kicks in. The multipliers
// only engage when the range is large enough that flying is actually useful;
// small ranges stay precise.
#define REPEAT_INTERVAL_MS 75
#define ACCEL_TIER1_CLICKS 10
#define ACCEL_TIER1_MIN_STEPS 60
#define ACCEL_TIER2_CLICKS 30
#define ACCEL_TIER2_MIN_STEPS 600
// Values from the phone are ignored this long after the last press, so an
// update from Home Assistant does not fight the wearer mid-adjust
#define EXTERNAL_UPDATE_HOLDOFF_MS 1000
// How long the value must hold still before a live selector reports it.
// Below the holdoff, so the echo of our own change lands inside it.
#define SETTLE_INTERVAL_MS 500

// CMD_NUMBER flags
#define NUMBER_BAR 1
#define NUMBER_LIVE 8

enum {
  CMD_MENU = 1,     // screen, title, total, replace: a menu (rows follow in CMD_ROWS)
  CMD_ROWS = 2,     // screen, first, text: rows "title\tsubtitle" separated by '\n'
  CMD_TEXT = 3,     // screen, title, text, replace: a scrolling text screen
  CMD_APPEND = 4,   // screen, text: more text for it
  CMD_IMAGE = 5,    // screen, title, text (caption), width, height, palette
  CMD_PIXELS = 6,   // screen, offset, pixels
  CMD_STATUS = 8,   // text, vibe: a banner on the top screen for a few seconds
  CMD_DICTATE = 10, // screen: start dictation and send back what was heard
  CMD_NUMBER = 11,  // screen, title, unit, value, min, max, step, decimals, flags: a number selector
  CMD_VALUE = 12,   // screen, value: the selector's value changed elsewhere
  CMD_CLOSE = 13,   // screen: leave it, as if back were pressed
};

typedef enum { KIND_MENU, KIND_TEXT, KIND_IMAGE, KIND_NUMBER } Kind;

typedef struct {
  Window *window;
  int32_t id;
  Kind kind;
  char *title;

  MenuLayer *menu;
  int count;
  char *rows[MAX_ROWS];

  ScrollLayer *scroll;
  TextLayer *text_layer;
  char *text;

  Layer *canvas;
  TextLayer *caption_layer;
  PluginBitmap image;
  char *caption;

  // A number selector. Values are integers scaled by 10^decimals, so the
  // watch needs no floating point.
  Layer *number_layer;
  int32_t value;
  int32_t min;
  int32_t max;
  int32_t step;
  uint8_t decimals;
  uint8_t flags;
  //! When a button was last pressed, to hold off values from the phone
  int64_t last_input_ms;
  //! Pending settle timer, and the value the last change carried so a value
  //! dialled away from and back to does not report twice
  AppTimer *settle_timer;
  int32_t last_sent_value;
  char unit[12];

  TextLayer *status;
  char status_text[96];
  AppTimer *status_timer;
} Screen;

static Screen *s_stack[MAX_DEPTH];
static int s_depth;
#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation;
static int32_t s_dictation_screen;
#endif

// ---- Helpers ------------------------------------------------------------------

static char *copy_string(const char *source, size_t length) {
  char *out = malloc(length + 1);
  if (!out) { return NULL; }
  memcpy(out, source, length);
  out[length] = '\0';
  return out;
}

static char *append_string(char *existing, const char *more) {
  size_t a = existing ? strlen(existing) : 0;
  size_t b = strlen(more);
  char *out = malloc(a + b + 1);
  if (!out) { return existing; }
  if (existing) { memcpy(out, existing, a); free(existing); }
  memcpy(out + a, more, b + 1);
  return out;
}

static Screen *find_screen(int32_t id) {
  for (int i = s_depth - 1; i >= 0; i--) {
    if (s_stack[i]->id == id) { return s_stack[i]; }
  }
  return NULL;
}

static Screen *top_screen(void) {
  return s_depth > 0 ? s_stack[s_depth - 1] : NULL;
}

static void send_ints(uint32_t key, int32_t screen, uint32_t key2, int32_t value) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) { return; }
  dict_write_int32(out, key, screen);
  if (key2) { dict_write_int32(out, key2, value); }
  app_message_outbox_send();
}

static void clear_rows(Screen *screen) {
  for (int i = 0; i < screen->count && i < MAX_ROWS; i++) {
    free(screen->rows[i]);
    screen->rows[i] = NULL;
  }
  screen->count = 0;
}

// ---- Status banner ------------------------------------------------------------

static void hide_status(void *context) {
  Screen *screen = context;
  screen->status_timer = NULL;
  layer_set_hidden(text_layer_get_layer(screen->status), true);
}

static void vibe(int32_t kind) {
  if (kind == 1) { vibes_short_pulse(); }
  if (kind == 2) { vibes_double_pulse(); }
}

//! A banner, unless the text is empty, and a vibe: 0 none, 1 short, 2 double
static void show_status_vibe(const char *text, int32_t kind) {
  vibe(kind);
  Screen *screen = top_screen();
  if (!screen || !*text) { return; }
  strncpy(screen->status_text, text, sizeof(screen->status_text) - 1);
  text_layer_set_text(screen->status, screen->status_text);
  layer_set_hidden(text_layer_get_layer(screen->status), false);
  if (screen->status_timer) { app_timer_cancel(screen->status_timer); }
  screen->status_timer = app_timer_register(STATUS_MS, hide_status, screen);
}

static void show_status(const char *text) {
  show_status_vibe(text, 1);
}

static void add_status(Screen *screen, Layer *root) {
  GRect bounds = layer_get_bounds(root);
  screen->status = text_layer_create(GRect(0, bounds.size.h - 44, bounds.size.w, 44));
  text_layer_set_background_color(screen->status, GColorBlack);
  text_layer_set_text_color(screen->status, GColorWhite);
  text_layer_set_font(screen->status, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(screen->status, GTextAlignmentCenter);
  text_layer_set_overflow_mode(screen->status, GTextOverflowModeTrailingEllipsis);
  layer_set_hidden(text_layer_get_layer(screen->status), true);
  layer_add_child(root, text_layer_get_layer(screen->status));
}

// ---- Menus --------------------------------------------------------------------

static uint16_t menu_rows(MenuLayer *menu, uint16_t section, void *context) {
  Screen *screen = context;
  return screen->count > 0 ? screen->count : 1;
}

static int16_t menu_header_height(MenuLayer *menu, uint16_t section, void *context) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *context) {
  Screen *screen = context;
  menu_cell_basic_header_draw(ctx, cell, screen->title ? screen->title : "");
}

static void menu_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  Screen *screen = context;
  if (screen->count == 0) {
    menu_cell_basic_draw(ctx, cell, "Loading...", NULL, NULL);
    return;
  }
  char *row = index->row < MAX_ROWS ? screen->rows[index->row] : NULL;
  if (!row) {
    menu_cell_basic_draw(ctx, cell, "...", NULL, NULL);
    return;
  }
  // "title\tsubtitle"; the tab is swapped for a terminator in place
  char *tab = strchr(row, '\t');
  if (tab) {
    *tab = '\0';
    menu_cell_basic_draw(ctx, cell, row, tab + 1, NULL);
    *tab = '\t';
  } else {
    menu_cell_basic_draw(ctx, cell, row, NULL, NULL);
  }
}

static void menu_select(MenuLayer *menu, MenuIndex *index, void *context) {
  Screen *screen = context;
  if (screen->count == 0) { return; }
  send_ints(MESSAGE_KEY_sel, screen->id, MESSAGE_KEY_index, index->row);
}

static void menu_long_select(MenuLayer *menu, MenuIndex *index, void *context) {
  Screen *screen = context;
  if (screen->count == 0) { return; }
  send_ints(MESSAGE_KEY_longsel, screen->id, MESSAGE_KEY_index, index->row);
}

// ---- Image screen -------------------------------------------------------------

static void draw_canvas(Layer *layer, GContext *ctx) {
  Screen *screen = *(Screen **)layer_get_data(layer);
  GRect bounds = layer_get_bounds(layer);
  GBitmap *bitmap = plugin_bitmap_get(&screen->image);
  if (!bitmap) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "Receiving...", fonts_get_system_font(FONT_KEY_GOTHIC_18),
                       bounds, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }
  GSize size = gbitmap_get_bounds(bitmap).size;
  // A grey checkerboard behind it shows what is transparent
  for (int y = 0; y < size.h; y += 8) {
    for (int x = 0; x < size.w; x += 8) {
      GRect cell = GRect((bounds.size.w - size.w) / 2 + x, 4 + y, 8, 8);
      graphics_context_set_fill_color(ctx, ((x + y) / 8) % 2 ? PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite) : GColorWhite);
      graphics_fill_rect(ctx, cell, 0, GCornerNone);
    }
  }
  plugin_bitmap_draw(ctx, &screen->image, GPoint((bounds.size.w - size.w) / 2, 4));
}

// ---- Number selector ----------------------------------------------------------
//
// Ported from the Home Assistant WS app's src/simply/simply_number.c, without
// its duration fields and touch handling. Up and down run entirely on the
// watch, with hold to repeat and acceleration. A live selector reports the
// value once it settles (`change`), and select reports it (`set`); the
// phone closes the selector when the value took.

static int64_t now_ms(void) {
  time_t seconds;
  uint16_t ms;
  time_ms(&seconds, &ms);
  return (int64_t)seconds * 1000 + ms;
}

//! Wide enough to take a sum or difference of two values without overflowing
static int32_t clamp(int64_t value, int32_t min, int32_t max) {
  if (value < min) { return min; }
  if (value > max) { return max; }
  return value;
}

// The scaled integer with its decimal point put back, e.g. 215 with 1
// decimal is "21.5", then the unit as it is
static void format_value(Screen *screen, char *out, size_t out_size) {
  int32_t pow10 = 1;
  for (uint8_t i = 0; i < screen->decimals; i++) { pow10 *= 10; }
  int32_t whole = screen->value / pow10;
  int32_t frac = screen->value % pow10;
  if (frac < 0) { frac = -frac; }
  if (screen->decimals == 0) {
    snprintf(out, out_size, "%ld%s", (long)whole, screen->unit);
    return;
  }
  char frac_buf[12];
  for (int8_t i = screen->decimals - 1; i >= 0; i--) {
    frac_buf[i] = '0' + (frac % 10);
    frac /= 10;
  }
  frac_buf[screen->decimals] = '\0';
  const char *sign = (screen->value < 0 && whole == 0) ? "-" : "";
  snprintf(out, out_size, "%s%ld.%s%s", sign, (long)whole, frac_buf, screen->unit);
}

static void draw_number(Layer *layer, GContext *ctx) {
  Screen *screen = *(Screen **)layer_get_data(layer);
  const GRect bounds = layer_get_bounds(layer);
  const int16_t w = bounds.size.w;
  const int16_t h = bounds.size.h;
  const int16_t inset = PBL_IF_ROUND_ELSE(24, 8);

  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorBlack);

  graphics_draw_text(ctx, screen->title ? screen->title : "",
      fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
      GRect(inset, PBL_IF_ROUND_ELSE(14, 2), w - 2 * inset, 52),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  char value_buf[32];
  format_value(screen, value_buf, sizeof(value_buf));
  graphics_draw_text(ctx, value_buf,
      fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
      GRect(0, h / 2 - 22, w, 34),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  // An outlined track with a filled part, which works on every display
  // without needing grey
  if (screen->flags & NUMBER_BAR) {
    const int16_t bar_margin = PBL_IF_ROUND_ELSE(34, 20);
    const GRect track = GRect(bar_margin, h / 2 + 20, w - 2 * bar_margin, 14);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_rect(ctx, track);
    const int64_t range = (int64_t)screen->max - screen->min;
    if (range > 0) {
      const int16_t fill_w =
          (int16_t)((int64_t)(track.size.w - 4) * ((int64_t)screen->value - screen->min) / range);
      if (fill_w > 0) {
        graphics_context_set_fill_color(ctx, GColorBlack);
        graphics_fill_rect(ctx, GRect(track.origin.x + 2, track.origin.y + 2, fill_w, track.size.h - 4),
            0, GCornerNone);
      }
    }
  }

  graphics_draw_text(ctx, "UP/DOWN adjust, hold to fly\nSELECT to set",
      fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GRect(inset, h - PBL_IF_ROUND_ELSE(52, 40), w - 2 * inset, 36),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static int32_t accel_delta(Screen *screen, uint8_t clicks) {
  const int64_t total_steps =
      screen->step > 0 ? ((int64_t)screen->max - screen->min) / screen->step : 0;
  int32_t mult = 1;
  if (clicks > ACCEL_TIER1_CLICKS && total_steps > ACCEL_TIER1_MIN_STEPS) { mult = 10; }
  if (clicks > ACCEL_TIER2_CLICKS && total_steps > ACCEL_TIER2_MIN_STEPS) { mult = 100; }
  return screen->step * mult;
}

static void cancel_settle(Screen *screen) {
  if (screen->settle_timer) {
    app_timer_cancel(screen->settle_timer);
    screen->settle_timer = NULL;
  }
}

static void settle_timeout(void *context) {
  Screen *screen = context;
  screen->settle_timer = NULL;
  const int32_t value = clamp(screen->value, screen->min, screen->max);
  if (value == screen->last_sent_value) { return; }
  screen->last_sent_value = value;
  send_ints(MESSAGE_KEY_change, screen->id, MESSAGE_KEY_value, value);
}

// Restart the countdown on every change, so a run of presses reports once
// it finishes rather than once per press
static void schedule_settle(Screen *screen) {
  if (!(screen->flags & NUMBER_LIVE)) { return; }
  if (screen->settle_timer) {
    if (app_timer_reschedule(screen->settle_timer, SETTLE_INTERVAL_MS)) { return; }
    screen->settle_timer = NULL;
  }
  screen->settle_timer = app_timer_register(SETTLE_INTERVAL_MS, settle_timeout, screen);
}

static void adjust(Screen *screen, int32_t delta) {
  const int32_t value = clamp((int64_t)screen->value + delta, screen->min, screen->max);
  screen->last_input_ms = now_ms();
  if (value != screen->value) {
    screen->value = value;
    schedule_settle(screen);
    layer_mark_dirty(screen->number_layer);
  }
}

static void number_up(ClickRecognizerRef recognizer, void *context) {
  Screen *screen = context;
  adjust(screen, accel_delta(screen, click_number_of_clicks_counted(recognizer)));
}

static void number_down(ClickRecognizerRef recognizer, void *context) {
  Screen *screen = context;
  adjust(screen, -accel_delta(screen, click_number_of_clicks_counted(recognizer)));
}

static void number_select(ClickRecognizerRef recognizer, void *context) {
  Screen *screen = context;
  // The set carries the value a pending change would have, so let it be
  // the one that reports it
  cancel_settle(screen);
  send_ints(MESSAGE_KEY_set, screen->id, MESSAGE_KEY_value, clamp(screen->value, screen->min, screen->max));
}

static void number_click_config(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, REPEAT_INTERVAL_MS, number_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, REPEAT_INTERVAL_MS, number_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, number_select);
}

//! A value from the phone, unless the wearer is busy with the buttons
static void number_value(Screen *screen, int32_t value) {
  if (now_ms() - screen->last_input_ms < EXTERNAL_UPDATE_HOLDOFF_MS) { return; }
  screen->value = clamp(value, screen->min, screen->max);
  // This came from the entity, so reporting it back would tell it what it
  // already knows; dialling away and back to it stays quiet too
  screen->last_sent_value = screen->value;
  if (screen->number_layer) { layer_mark_dirty(screen->number_layer); }
}

// ---- Screens ------------------------------------------------------------------

static void window_load(Window *window) {
  Screen *screen = window_get_user_data(window);
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  if (screen->kind == KIND_MENU) {
    screen->menu = menu_layer_create(bounds);
    menu_layer_set_callbacks(screen->menu, screen, (MenuLayerCallbacks) {
      .get_num_sections = NULL,
      .get_num_rows = menu_rows,
      .get_header_height = menu_header_height,
      .draw_header = menu_draw_header,
      .draw_row = menu_draw_row,
      .select_click = menu_select,
      .select_long_click = menu_long_select,
    });
#if defined(PBL_COLOR)
    menu_layer_set_highlight_colors(screen->menu, GColorCobaltBlue, GColorWhite);
#endif
    menu_layer_set_click_config_onto_window(screen->menu, window);
    layer_add_child(root, menu_layer_get_layer(screen->menu));
  } else if (screen->kind == KIND_TEXT) {
    screen->scroll = scroll_layer_create(bounds);
    scroll_layer_set_click_config_onto_window(screen->scroll, window);
    screen->text_layer = text_layer_create(GRect(4, 0, bounds.size.w - 8, 4000));
    text_layer_set_font(screen->text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
    scroll_layer_add_child(screen->scroll, text_layer_get_layer(screen->text_layer));
    layer_add_child(root, scroll_layer_get_layer(screen->scroll));
  } else if (screen->kind == KIND_NUMBER) {
    screen->number_layer = layer_create_with_data(bounds, sizeof(Screen *));
    *(Screen **)layer_get_data(screen->number_layer) = screen;
    layer_set_update_proc(screen->number_layer, draw_number);
    layer_add_child(root, screen->number_layer);
  } else {
    screen->canvas = layer_create_with_data(bounds, sizeof(Screen *));
    *(Screen **)layer_get_data(screen->canvas) = screen;
    layer_set_update_proc(screen->canvas, draw_canvas);
    layer_add_child(root, screen->canvas);
    screen->caption_layer = text_layer_create(GRect(2, bounds.size.h / 2 + 10, bounds.size.w - 4, bounds.size.h / 2 - 10));
    text_layer_set_font(screen->caption_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(screen->caption_layer, GTextAlignmentCenter);
    text_layer_set_text(screen->caption_layer, screen->caption ? screen->caption : "");
    layer_add_child(root, text_layer_get_layer(screen->caption_layer));
  }
  add_status(screen, root);
}

static void refresh_text(Screen *screen) {
  if (!screen->text_layer) { return; }
  text_layer_set_text(screen->text_layer, screen->text ? screen->text : "");
  GRect bounds = layer_get_bounds(window_get_root_layer(screen->window));
  // Measured in a tall frame: the content size never comes out taller
  // than the frame it is measured in
  text_layer_set_size(screen->text_layer, GSize(bounds.size.w - 8, 4000));
  GSize size = text_layer_get_content_size(screen->text_layer);
  text_layer_set_size(screen->text_layer, GSize(bounds.size.w - 8, size.h + 8));
  scroll_layer_set_content_size(screen->scroll, GSize(bounds.size.w, size.h + 16));
}

static void window_appear(Window *window) {
  Screen *screen = window_get_user_data(window);
  if (screen->kind == KIND_TEXT) { refresh_text(screen); }
}

static void free_screen(Screen *screen) {
  if (screen->status_timer) { app_timer_cancel(screen->status_timer); }
  // Leaving without setting means the last value was not chosen, so a
  // pending change has nothing to report
  cancel_settle(screen);
  if (screen->number_layer) { layer_destroy(screen->number_layer); }
  if (screen->menu) { menu_layer_destroy(screen->menu); }
  if (screen->text_layer) { text_layer_destroy(screen->text_layer); }
  if (screen->scroll) { scroll_layer_destroy(screen->scroll); }
  if (screen->canvas) { layer_destroy(screen->canvas); }
  if (screen->caption_layer) { text_layer_destroy(screen->caption_layer); }
  text_layer_destroy(screen->status);
  clear_rows(screen);
  plugin_bitmap_free(&screen->image);
  free(screen->title);
  free(screen->text);
  free(screen->caption);
  free(screen);
}

static void window_unload(Window *window) {
  Screen *screen = window_get_user_data(window);
  // The phone forgets the screen and stops whatever was feeding it
  send_ints(MESSAGE_KEY_back, screen->id, 0, 0);
  for (int i = 0; i < s_depth; i++) {
    if (s_stack[i] == screen) {
      memmove(&s_stack[i], &s_stack[i + 1], (s_depth - i - 1) * sizeof(Screen *));
      s_depth--;
      break;
    }
  }
  free_screen(screen);
  window_destroy(window);
}

static Screen *push_screen(int32_t id, Kind kind, const char *title) {
  if (s_depth >= MAX_DEPTH) {
    show_status("Too deep: go back first");
    return NULL;
  }
  Screen *screen = calloc(1, sizeof(Screen));
  if (!screen) { return NULL; }
  screen->id = id;
  screen->kind = kind;
  screen->title = copy_string(title, strlen(title));
  screen->window = window_create();
  window_set_user_data(screen->window, screen);
  window_set_window_handlers(screen->window, (WindowHandlers) {
    .load = window_load,
    .appear = window_appear,
    .unload = window_unload,
  });
  if (kind == KIND_NUMBER) {
    window_set_click_config_provider_with_context(screen->window, number_click_config, screen);
  }
  s_stack[s_depth++] = screen;
  window_stack_push(screen->window, true);
  return screen;
}

// ---- Messages from the phone --------------------------------------------------

static const char *string_of(DictionaryIterator *in, uint32_t key) {
  Tuple *t = dict_find(in, key);
  return t && t->type == TUPLE_CSTRING ? t->value->cstring : "";
}

static int32_t int_of(DictionaryIterator *in, uint32_t key) {
  Tuple *t = dict_find(in, key);
  return t ? t->value->int32 : 0;
}

static void add_rows(Screen *screen, int first, const char *text) {
  int index = first;
  const char *start = text;
  while (*start && index < MAX_ROWS) {
    const char *end = strchr(start, '\n');
    size_t length = end ? (size_t)(end - start) : strlen(start);
    free(screen->rows[index]);
    screen->rows[index] = copy_string(start, length);
    index++;
    if (!end) { break; }
    start = end + 1;
  }
  if (screen->menu) { menu_layer_reload_data(screen->menu); }
}

#if defined(PBL_MICROPHONE)
static void dictation_done(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) { return; }
  dict_write_int32(out, MESSAGE_KEY_screen, s_dictation_screen);
  dict_write_cstring(out, MESSAGE_KEY_dictation, status == DictationSessionStatusSuccess ? transcription : "");
  app_message_outbox_send();
}
#endif

static void inbox_received(DictionaryIterator *in, void *context) {
  int32_t cmd = int_of(in, MESSAGE_KEY_cmd);
  int32_t id = int_of(in, MESSAGE_KEY_screen);
  bool replace = int_of(in, MESSAGE_KEY_replace) != 0;
  Screen *screen = find_screen(id);

  switch (cmd) {
    case CMD_MENU:
      // An update for a screen already left is dropped, not reopened
      if (replace && !screen) { return; }
      if (!replace) { screen = push_screen(id, KIND_MENU, string_of(in, MESSAGE_KEY_title)); }
      if (!screen) { return; }
      if (replace) {
        free(screen->title);
        screen->title = copy_string(string_of(in, MESSAGE_KEY_title), strlen(string_of(in, MESSAGE_KEY_title)));
      }
      clear_rows(screen);
      screen->count = int_of(in, MESSAGE_KEY_total);
      if (screen->count > MAX_ROWS) { screen->count = MAX_ROWS; }
      if (screen->menu) { menu_layer_reload_data(screen->menu); }
      break;
    case CMD_ROWS:
      if (screen) { add_rows(screen, int_of(in, MESSAGE_KEY_first), string_of(in, MESSAGE_KEY_text)); }
      break;
    case CMD_TEXT:
      if (replace && !screen) { return; }
      if (!replace) { screen = push_screen(id, KIND_TEXT, string_of(in, MESSAGE_KEY_title)); }
      if (!screen) { return; }
      free(screen->text);
      screen->text = copy_string(string_of(in, MESSAGE_KEY_text), strlen(string_of(in, MESSAGE_KEY_text)));
      refresh_text(screen);
      break;
    case CMD_APPEND:
      if (screen) {
        screen->text = append_string(screen->text, string_of(in, MESSAGE_KEY_text));
        refresh_text(screen);
      }
      break;
    case CMD_IMAGE: {
      screen = push_screen(id, KIND_IMAGE, string_of(in, MESSAGE_KEY_title));
      if (!screen) { return; }
      const char *caption = string_of(in, MESSAGE_KEY_text);
      screen->caption = copy_string(caption, strlen(caption));
      if (screen->caption_layer) { text_layer_set_text(screen->caption_layer, screen->caption); }
      Tuple *palette = dict_find(in, MESSAGE_KEY_palette);
      plugin_bitmap_begin(&screen->image, int_of(in, MESSAGE_KEY_width), int_of(in, MESSAGE_KEY_height),
                          palette ? palette->value->data : NULL, palette ? palette->length : 0);
      break;
    }
    case CMD_PIXELS: {
      Tuple *pixels = dict_find(in, MESSAGE_KEY_pixels);
      if (screen && pixels) {
        plugin_bitmap_add(&screen->image, int_of(in, MESSAGE_KEY_offset), pixels->value->data, pixels->length);
        if (screen->canvas) { layer_mark_dirty(screen->canvas); }
      }
      break;
    }
    case CMD_STATUS:
      // Without a vibe it buzzes once, as it always has
      show_status_vibe(string_of(in, MESSAGE_KEY_text),
                       dict_find(in, MESSAGE_KEY_vibe) ? int_of(in, MESSAGE_KEY_vibe) : 1);
      break;
    case CMD_NUMBER: {
      screen = push_screen(id, KIND_NUMBER, string_of(in, MESSAGE_KEY_title));
      if (!screen) { return; }
      const char *unit = string_of(in, MESSAGE_KEY_unit);
      strncpy(screen->unit, unit, sizeof(screen->unit) - 1);
      screen->min = int_of(in, MESSAGE_KEY_min);
      screen->max = int_of(in, MESSAGE_KEY_max);
      if (screen->max < screen->min) { screen->max = screen->min; }
      screen->step = int_of(in, MESSAGE_KEY_step) > 0 ? int_of(in, MESSAGE_KEY_step) : 1;
      // Past 9 the scale no longer fits the 32-bit value
      screen->decimals = int_of(in, MESSAGE_KEY_decimals) > 9 ? 9 : int_of(in, MESSAGE_KEY_decimals);
      screen->flags = int_of(in, MESSAGE_KEY_flags);
      screen->value = clamp(int_of(in, MESSAGE_KEY_value), screen->min, screen->max);
      screen->last_sent_value = screen->value;
      if (screen->number_layer) { layer_mark_dirty(screen->number_layer); }
      break;
    }
    case CMD_VALUE:
      if (screen && screen->kind == KIND_NUMBER) { number_value(screen, int_of(in, MESSAGE_KEY_value)); }
      break;
    case CMD_CLOSE:
      // Unloading it tells the phone, the same as back
      if (screen) { window_stack_remove(screen->window, true); }
      break;
    case CMD_DICTATE:
#if defined(PBL_MICROPHONE)
      s_dictation_screen = id;
      if (!s_dictation) { s_dictation = dictation_session_create(256, dictation_done, NULL); }
      if (s_dictation) { dictation_session_start(s_dictation); }
#else
      {
        DictionaryIterator *out;
        if (app_message_outbox_begin(&out) == APP_MSG_OK) {
          dict_write_int32(out, MESSAGE_KEY_screen, id);
          dict_write_cstring(out, MESSAGE_KEY_dictation, "");
          app_message_outbox_send();
        }
        show_status("This watch has no microphone");
      }
#endif
      break;
  }
}

// ---- App ----------------------------------------------------------------------

static void say_ready(void *context) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    app_timer_register(500, say_ready, NULL);
    return;
  }
  GRect bounds = layer_get_bounds(window_get_root_layer(s_stack[0]->window));
  dict_write_int32(out, MESSAGE_KEY_ready, 1);
  dict_write_int32(out, MESSAGE_KEY_width, bounds.size.w);
  dict_write_int32(out, MESSAGE_KEY_height, bounds.size.h);
  dict_write_int32(out, MESSAGE_KEY_color, PBL_IF_COLOR_ELSE(1, 0));
  dict_write_int32(out, MESSAGE_KEY_mic, PBL_IF_MICROPHONE_ELSE(1, 0));
  app_message_outbox_send();
}

int main(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_open(PBL_IF_COLOR_ELSE(4096, 2048), 256);

  // A placeholder until the phone sends the real first screen over it
  Screen *first = push_screen(0, KIND_MENU, "HA Plugin Tester");
  first->count = 0;
  app_timer_register(300, say_ready, NULL);

  app_event_loop();
  window_stack_pop_all(false);
}
