/*
 * HA Plugin Tester, the phone half.
 *
 * Builds every screen from what the Home Assistant WS plugin itself
 * declares (Pebble.enumeratePlugins), so a source or action added to the
 * plugin shows up here without a change. The watch half only draws menus,
 * text, bitmaps and number selectors; see src/c/main.c for the commands.
 *
 * Home is the exception: it is built the way the Home Assistant WS app shows
 * entities, with a details page per kind, so the plugin can be tried the way
 * an app would use it.
 */
var HA = '61ae3254-ce00-49db-aad8-23143f649b90';

var CMD = { MENU: 1, ROWS: 2, TEXT: 3, APPEND: 4, IMAGE: 5, PIXELS: 6, STATUS: 8, DICTATE: 10, NUMBER: 11, VALUE: 12, CLOSE: 13 };
var VIBE = { NONE: 0, SHORT: 1, DOUBLE: 2 };
var MAX_ROWS = 64;
//! Bytes of text or pixels in one message, well inside the watch's inbox
var CHUNK = 900;

var watch = { width: 144, height: 168, color: false, mic: false };
var screens = {};
var nextId = 1;
var dictationDone = null;

function log(text) { console.log('[tester] ' + text); }

// ---- Sending ------------------------------------------------------------------

var queue = [];
var sending = false;

function send(message) {
  queue.push(message);
  pump();
}

function pump() {
  if (sending || queue.length === 0) { return; }
  sending = true;
  var message = queue[0];
  var tries = 0;
  function next() {
    queue.shift();
    sending = false;
    pump();
  }
  function attempt() {
    Pebble.sendAppMessage(message, next, function() {
      if (++tries < 4) { setTimeout(attempt, 300); } else { log('dropped a message to the watch'); next(); }
    });
  }
  attempt();
}

function utf8Length(text) { return unescape(encodeURIComponent(text)).length; }

//! Text cut into pieces of at most `limit` UTF-8 bytes
function chunks(text, limit) {
  var out = [];
  var piece = '';
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var size = utf8Length(text[i]);
    if (bytes + size > limit) { out.push(piece); piece = ''; bytes = 0; }
    piece += text[i];
    bytes += size;
  }
  if (piece || out.length === 0) { out.push(piece); }
  return out;
}

//! One line for a menu row: no tabs or newlines, and not too long
function clean(text, max) {
  text = String(text === undefined || text === null ? '' : text).replace(/[\t\n\r]+/g, ' ');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---- Screens ------------------------------------------------------------------

/**
 * A menu. Rows are { title, subtitle, select, hold }. Passing `screen`
 * redraws that screen in place instead of opening a new one.
 */
function menu(title, rows, screen) {
  var replace = !!screen;
  screen = screen || { id: nextId++ };
  screen.kind = 'menu';
  screen.title = title;
  screen.rows = rows.slice(0, MAX_ROWS);
  screens[screen.id] = screen;
  send({ cmd: CMD.MENU, screen: screen.id, title: clean(title, 30), total: screen.rows.length, replace: replace ? 1 : 0 });
  var lines = [];
  var first = 0;
  var bytes = 0;
  screen.rows.forEach(function(row, i) {
    var line = clean(row.title, 40) + '\t' + clean(row.subtitle, 80);
    var size = utf8Length(line) + 1;
    if (lines.length > 0 && bytes + size > CHUNK) {
      send({ cmd: CMD.ROWS, screen: screen.id, first: first, text: lines.join('\n') });
      lines = [];
      first = i;
      bytes = 0;
    }
    lines.push(line);
    bytes += size;
  });
  if (lines.length > 0) { send({ cmd: CMD.ROWS, screen: screen.id, first: first, text: lines.join('\n') }); }
  return screen;
}

/** A scrolling text screen; the watch has room for a few thousand characters */
function text(title, body, screen) {
  var replace = !!screen;
  screen = screen || { id: nextId++ };
  screen.kind = 'text';
  screens[screen.id] = screen;
  var limit = watch.color ? 6000 : 2500;
  body = String(body);
  if (body.length > limit) { body = body.slice(0, limit) + '\n…(cut, ' + body.length + ' characters in all)'; }
  var pieces = chunks(body, CHUNK);
  send({ cmd: CMD.TEXT, screen: screen.id, title: clean(title, 30), text: pieces[0], replace: replace ? 1 : 0 });
  for (var i = 1; i < pieces.length; i++) { send({ cmd: CMD.APPEND, screen: screen.id, text: pieces[i] }); }
  return screen;
}

function base64Bytes(data) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < data.length; i++) {
    var value = alphabet.indexOf(data[i]);
    if (value < 0) { continue; }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xFF);
    }
  }
  return bytes;
}

/** An `icon` or `image` shape drawn on the watch, with a caption under it */
function image(title, caption, shape) {
  var screen = { id: nextId++, kind: 'image' };
  screens[screen.id] = screen;
  var pixels = base64Bytes(shape.pixels || '');
  var palette = base64Bytes(shape.palette || '');
  var expected = Math.ceil(shape.width / 2) * shape.height;
  caption = shape.width + 'x' + shape.height + ', ' + palette.length + ' colours, ' + pixels.length + ' bytes' +
    (pixels.length !== expected ? ' (expected ' + expected + '!)' : '') + '\n' + caption;
  send({ cmd: CMD.IMAGE, screen: screen.id, title: clean(title, 30), text: clean(caption, 200).replace(' (expected', '\n(expected'),
    width: shape.width, height: shape.height, palette: palette });
  for (var offset = 0; offset < pixels.length; offset += CHUNK) {
    send({ cmd: CMD.PIXELS, screen: screen.id, offset: offset, pixels: pixels.slice(offset, offset + CHUNK) });
  }
  return screen;
}

/** A banner on the top screen; it buzzes once unless `vibe` says otherwise */
function status(message, vibe) {
  var out = { cmd: CMD.STATUS, text: clean(message, 90) };
  if (vibe !== undefined) { out.vibe = vibe; }
  send(out);
}

function buzz(vibe) {
  send({ cmd: CMD.STATUS, text: '', vibe: vibe });
}

function closeScreen(screen) {
  if (screens[screen.id]) { send({ cmd: CMD.CLOSE, screen: screen.id }); }
}

/**
 * A number selector, the Home Assistant WS app's NumberField. Up and down
 * run on the watch; values cross as integers scaled by 10^decimals.
 *
 *   numberSelector({ title, unit, value, min, max, step, decimals, bar,
 *                    onChange, onSet })
 *
 * onChange(value) makes it live: the watch reports each value once it has
 * settled. onSet(value) is select; close the selector when the value took.
 * The returned screen's value(v) shows a value from elsewhere, which the
 * watch ignores while the wearer is pressing buttons.
 */
function numberSelector(options) {
  var decimals = options.decimals || 0;
  var scale = Math.pow(10, decimals);
  function scaled(v) { return Math.round(v * scale); }
  var screen = { id: nextId++, kind: 'number' };
  screens[screen.id] = screen;
  screen.onChange = options.onChange ? function(v) { options.onChange(v / scale); } : null;
  screen.onSet = function(v) { options.onSet(v / scale); };
  screen.value = function(v) {
    if (screens[screen.id] && typeof v === 'number' && isFinite(v)) {
      send({ cmd: CMD.VALUE, screen: screen.id, value: scaled(v) });
    }
  };
  send({
    cmd: CMD.NUMBER, screen: screen.id, title: clean(options.title, 30), unit: clean(options.unit || '', 10),
    value: scaled(typeof options.value === 'number' && isFinite(options.value) ? options.value : options.min),
    min: scaled(options.min), max: scaled(options.max), step: Math.max(1, scaled(options.step || 1)),
    decimals: decimals, flags: (options.bar ? 1 : 0) | (options.onChange ? 8 : 0)
  });
  return screen;
}

// ---- Reading the plugin ------------------------------------------------------

function haPlugin() {
  var plugins = typeof Pebble.enumeratePlugins === 'function' ? Pebble.enumeratePlugins() : [];
  for (var i = 0; i < plugins.length; i++) {
    if (plugins[i].uuid === HA) { return plugins[i]; }
  }
  return null;
}

function json(value) {
  try { return JSON.stringify(value, null, 1); } catch (e) { return String(value); }
}

function timeText(seconds) {
  var d = new Date(seconds * 1000);
  var hh = ('0' + d.getHours()).slice(-2);
  var mm = ('0' + d.getMinutes()).slice(-2);
  var today = new Date();
  var sameDay = d.toDateString() === today.toDateString();
  return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hh + ':' + mm;
}

/** One property's shapes, as a short line */
function shapeSummary(shapes) {
  if (!shapes || typeof shapes !== 'object') { return String(shapes); }
  if (shapes.series) {
    var s = shapes.series;
    var kinds = Object.keys(s).filter(function(k) { return k !== 'start' && k !== 'stepSec'; });
    var any = s[kinds[0]];
    var count = any && any.values ? any.values.length : 0;
    return 'series ' + count + ' × ' + (s.stepSec / 3600) + 'h from ' + timeText(s.start) + ' [' + kinds.join(',') + ']';
  }
  var parts = [];
  if (shapes.shortText) { parts.push(shapes.shortText.text); }
  if (shapes.longText && (!shapes.shortText || shapes.longText.text !== shapes.shortText.text)) { parts.push(shapes.longText.text); }
  if (shapes.numericValue) {
    var n = shapes.numericValue;
    parts.push(n.value + (n.unit || '') + (n.min !== undefined ? ' [' + n.min + '..' + n.max + ']' : ''));
  }
  if (shapes.boolean) { parts.push(shapes.boolean.value ? 'true' : 'false'); }
  if (shapes.timestamp) { parts.push(timeText(shapes.timestamp.value)); }
  if (shapes.icon) { parts.push('icon ' + shapes.icon.width + 'x' + shapes.icon.height); }
  if (shapes.image) { parts.push('image ' + shapes.image.width + 'x' + shapes.image.height); }
  return parts.join(' | ');
}

function propertyText(instance, name) {
  var shapes = instance.properties && instance.properties[name];
  if (!shapes) { return ''; }
  if (shapes.shortText) { return shapes.shortText.text; }
  if (shapes.numericValue) { return shapes.numericValue.value + (shapes.numericValue.unit || ''); }
  if (shapes.boolean) { return shapes.boolean.value ? 'on' : 'off'; }
  return '';
}

/** A line about an instance for its row in a list */
function instanceSummary(instance) {
  var props = instance.properties || {};
  var names = ['state', 'value', 'on', 'temperature', 'condition', 'brightness', 'position', 'locked', 'armed', 'playing', 'home', 'configured'];
  var parts = [];
  names.forEach(function(name) {
    if (props[name] && parts.length < 3) { parts.push(name + ' ' + propertyText(instance, name)); }
  });
  return parts.join(', ') || instance.instanceId;
}

function errorRows(err, retry) {
  var rows = [{
    title: 'Error ' + ((err && err.code) || '?'),
    subtitle: (err && err.message) || '',
    select: function() { text('Error', json(err)); }
  }];
  if (retry) { rows.push({ title: 'Try again', select: retry }); }
  return rows;
}

// ---- Actions -----------------------------------------------------------------

function numberOf(instance, name) {
  var shapes = instance && instance.properties && instance.properties[name];
  return shapes && shapes.numericValue ? shapes.numericValue.value : null;
}

//! Whether the entity's supported_features has `bit`; true when it sends none
function supports(instance, bit) {
  var features = numberOf(instance, 'supported_features');
  return features === null || (features & bit) !== 0;
}

//! A comma separated list the plugin sends as longText, or null without one
function listOf(instance, name) {
  var shapes = instance && instance.properties && instance.properties[name];
  var text = shapes && shapes.longText ? shapes.longText.text : '';
  return text ? text.split(',') : null;
}

//! A few sets of arguments worth trying for each action, besides instanceId
function presetsFor(action, instance) {
  var id = instance && instance.instanceId;
  var domain = id ? id.split('.')[0] : '';
  switch (action) {
    case 'set_on': return [{ on: true }, { on: false }];
    case 'set_brightness': return [{ percent: 10 }, { percent: 50 }, { percent: 100 }];
    case 'set_temperature': {
      var target = numberOf(instance, 'target_temperature');
      return target !== null ? [{ temperature: target - 1 }, { temperature: target + 1 }] : [{ temperature: 20 }, { temperature: 22 }];
    }
    case 'set_hvac_mode': return [{ hvac_mode: 'heat' }, { hvac_mode: 'cool' }, { hvac_mode: 'auto' }, { hvac_mode: 'off' }];
    case 'set_position': return [{ position: 0 }, { position: 50 }, { position: 100 }];
    case 'alarm_arm': return [{ mode: 'home' }, { mode: 'away' }, { mode: 'night' }];
    case 'set_playing': return [{ playing: true }, { playing: false }];
    case 'set_volume': return [{ percent: 20 }, { percent: 50 }];
    case 'call_service': {
      var services = {
        select: 'select_next', input_select: 'select_next', input_number: 'increment', counter: 'increment',
        button: 'press', input_button: 'press', vacuum: 'return_to_base', fan: 'increase_speed',
        automation: 'trigger', cover: 'stop_cover', lock: 'lock'
      };
      return [{ service: services[domain] || 'toggle' }, { service: 'turn_on' }];
    }
    case 'ask_assistant': return [{ text: 'What is the temperature inside?' }, { text: 'What time is it?', new_conversation: true }];
    case 'send_to_agent': return [{ message: 'Which lights are on?' }];
    default: return [{}];
  }
}

function argsLabel(args) {
  var parts = Object.keys(args).filter(function(k) { return k !== 'instanceId'; }).map(function(k) {
    return k + '=' + (typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]));
  });
  return parts.join(' ') || '(no arguments)';
}

/** Call an action and say how it went, in a banner and as text when held */
function invoke(action, args, onResult) {
  status('Calling ' + action + '…');
  var started = Date.now();
  Pebble.invokeAction({ plugin: HA, action: action, args: args }).then(function(result) {
    var ms = Date.now() - started;
    log(action + ' ' + JSON.stringify(args) + ' -> ' + JSON.stringify(result));
    status(result.ok ? 'OK (' + ms + 'ms): ' + (result.text || '') : (result.code || 'ERROR') + ': ' + (result.message || ''));
    if (onResult) { onResult(result, ms); }
  });
}

//! Actions that open, unlock or disarm something real: only on a long press
var DANGEROUS = { unlock: true, open: true, alarm_disarm: true };

function actionRows(actions, instance) {
  var rows = [];
  actions.forEach(function(action) {
    presetsFor(action.name, instance).forEach(function(preset) {
      var args = {};
      Object.keys(preset).forEach(function(k) { args[k] = preset[k]; });
      if (instance) { args.instanceId = instance.instanceId; }
      rows.push({
        title: action.name + (DANGEROUS[action.name] ? ' (hold)' : ''),
        subtitle: argsLabel(args),
        select: function() {
          if (DANGEROUS[action.name]) { return status('Hold select to really ' + action.name.replace('_', ' ')); }
          invoke(action.name, args);
        },
        hold: function() {
          invoke(action.name, args, function(result, ms) {
            text(action.name, 'Arguments:\n' + json(args) + '\n\nResult after ' + ms + 'ms:\n' + json(result));
          });
        }
      });
    });
  });
  return rows;
}

//! Actions that act on instances of this source: their targets name it
function actionsFor(category, item) {
  var plugin = haPlugin();
  if (!plugin) { return []; }
  var key = category + '/' + item;
  return plugin.actions.filter(function(action) {
    return (action.targets || []).some(function(target) {
      return target === key || target.indexOf(key + '/') === 0;
    });
  });
}

function entityActions() {
  var plugin = haPlugin();
  return plugin ? plugin.actions.filter(function(action) { return (action.targets || []).length > 0; }) : [];
}

// ---- Instances ---------------------------------------------------------------

/** A series as rows, one per value; a bitmap value opens as a picture */
function seriesScreen(name, series) {
  var kinds = Object.keys(series).filter(function(k) { return k !== 'start' && k !== 'stepSec'; });
  var count = 0;
  kinds.forEach(function(k) { count = Math.max(count, (series[k].values || []).length); });
  var rows = [];
  for (var i = 0; i < count; i++) {
    (function(index) {
      var at = series.start + index * series.stepSec;
      var parts = [];
      var bitmaps = [];
      kinds.forEach(function(kind) {
        var value = (series[kind].values || [])[index];
        if (value === null || value === undefined) { return; }
        if (kind === 'icon' || kind === 'image') { bitmaps.push(kind); return; }
        if (kind === 'timestamp') { parts.push(timeText(value)); return; }
        parts.push(String(value) + (kind === 'numericValue' && series[kind].unit ? series[kind].unit : ''));
      });
      rows.push({
        title: (series.stepSec >= 86400 ? 'Day ' + index : timeText(at)),
        subtitle: (parts.join(' | ') || 'null') + (bitmaps.length ? ' +' + bitmaps.join('+') : ''),
        select: function() {
          if (bitmaps.length) {
            image(name + ' ' + index, bitmaps[0] + ' at ' + timeText(at), series[bitmaps[0]].values[index]);
          }
        },
        hold: function() {
          if (bitmaps.length > 1) { image(name + ' ' + index, bitmaps[1] + ' at ' + timeText(at), series[bitmaps[1]].values[index]); }
        }
      });
    })(i);
  }
  menu(name + ' (' + count + ')', rows);
}

function instanceScreen(category, item, instance) {
  var props = instance.properties || {};
  var rows = [{
    title: 'Id',
    subtitle: instance.instanceId,
    select: function() { text('Instance', json(instance)); }
  }];
  Object.keys(props).forEach(function(name) {
    var shapes = props[name];
    rows.push({
      title: name,
      subtitle: shapeSummary(shapes),
      select: function() {
        if (shapes.series) { return seriesScreen(name, shapes.series); }
        if (shapes.image) { return image(name, 'image of ' + instance.instanceId, shapes.image); }
        if (shapes.icon) { return image(name, 'icon of ' + instance.instanceId, shapes.icon); }
        text(name, json(shapes));
      },
      hold: function() {
        if (shapes.icon) { return image(name, 'icon of ' + instance.instanceId, shapes.icon); }
        text(name, json(shapes));
      }
    });
  });
  var actions = actionRows(actionsFor(category, item), instance);
  if (category === 'home') {
    rows.push({
      title: 'Every action…',
      subtitle: 'including ones meant for other kinds',
      select: function() { menu('All on ' + instance.instanceId, actionRows(entityActions(), instance)); }
    });
  }
  menu(clean(propertyText(instance, 'name') || instance.instanceId, 30), rows.concat(actions));
}

/**
 * A live list of a source's instances. It redraws when the source sends an
 * update, and stops listening when the watch leaves it. `options.row` builds
 * an instance's row in place of the raw one, and `options.filter` leaves
 * instances out.
 */
function sourceScreen(category, item, options) {
  options = options || {};
  var title = options.title || category + '/' + item;
  var screen = menu(title, []);
  var subscription = null;
  var last = '';
  var updates = 0;

  function show(envelope) {
    updates++;
    var instances = (envelope && envelope.instances) || [];
    var rows = [];
    var from = envelope && envelope.pluginUuid;
    if (options.showSource || (from && from !== HA)) {
      rows.push({
        title: from === HA ? 'From the HA plugin' : 'From ' + (from || 'unknown'),
        subtitle: 'update ' + updates + ', valid until ' + (envelope.validUntilMs ? timeText(envelope.validUntilMs / 1000) : '?'),
        select: function() { text('Envelope', json({ pluginUuid: from, validUntilMs: envelope.validUntilMs, count: instances.length })); }
      });
    }
    instances.forEach(function(instance) {
      if (options.filter && !options.filter(instance)) { return; }
      if (options.row) { return rows.push(options.row(instance)); }
      rows.push({
        title: propertyText(instance, 'name') || instance.instanceId,
        subtitle: instanceSummary(instance),
        select: function() {
          if (options.onPick) { options.onPick(instance); } else { instanceScreen(category, item, instance); }
        },
        // As in the app, holding an entity does its quick action. Its raw
        // reply is under Id once it is open.
        hold: function() {
          if (category !== 'home' || !quickAction(instance)) { text(instance.instanceId, json(instance)); }
        }
      });
    });
    if (rows.length === 0) { rows.push({ title: 'No instances', subtitle: 'Nothing shared of this kind' }); }
    var signature = JSON.stringify(rows.map(function(r) { return [r.title, r.subtitle]; }));
    if (signature === last && screens[screen.id] && screens[screen.id].rows.length) {
      // Same on the watch, but the rows' handlers get the newest instances
      screen.rows = rows.slice(0, MAX_ROWS);
      return;
    }
    last = signature;
    if (screens[screen.id]) { menu(title, rows, screen); }
  }

  function start() {
    var request = {
      category: category,
      item: item,
      onData: show,
      onError: function(err) {
        log(category + '/' + item + ' error ' + JSON.stringify(err));
        if (screens[screen.id]) { menu(title, errorRows(err, restart), screen); }
      }
    };
    if (!options.anyPlugin) { request.plugin = HA; }
    if (options.properties) { request.properties = options.properties; }
    if (options.iconPixelSize) { request.iconPixelSize = options.iconPixelSize; }
    try {
      subscription = Pebble.subscribeToSource(request);
    } catch (e) {
      menu(title, errorRows({ code: 'THROWN', message: String(e) }), screen);
    }
  }

  function restart() {
    if (subscription) { subscription.unsubscribe(); }
    menu(title, [], screen);
    start();
  }

  screen.onClose = function() { if (subscription) { subscription.unsubscribe(); } };
  start();
  return screen;
}

function iconSize() {
  var side = Math.min(watch.width, Math.floor(watch.height / 2) - 6);
  return { w: side, h: side };
}

// ---- The menus ---------------------------------------------------------------

function permissionLines(done) {
  var names = ['Location', 'Internet', HA + ':InvokeAction', HA + ':Unlock', HA + ':Assistant', 'InvokeAction', 'Unlock', 'Assistant'];
  if (!Pebble.permissions || typeof Pebble.permissions.query !== 'function') {
    return done(['Pebble.permissions.query is missing (Pebble app before 1.17)']);
  }
  var lines = [];
  var pending = names.length;
  names.forEach(function(name, i) {
    Pebble.permissions.query(name).then(function(state) {
      lines[i] = name.replace(HA + ':', 'HA:') + ' = ' + state;
    }, function(err) {
      lines[i] = name.replace(HA + ':', 'HA:') + ' failed: ' + err;
    }).then(function() {
      if (--pending === 0) { done(lines); }
    });
  });
}

function statusScreen() {
  var screen = text('Plugin & permissions', 'Checking…');
  var plugin = haPlugin();
  var lines = [];
  if (!plugin) {
    lines.push('Home Assistant WS plugin NOT found.');
    lines.push('Install the plugins-poc build of Home Assistant WS, and turn on Plugins / permissions preview in the Pebble app.');
  } else {
    lines.push('Plugin: ' + plugin.name);
    lines.push('Sources (' + plugin.sources.length + '):');
    plugin.sources.forEach(function(source) {
      lines.push(' ' + source.category + '/' + source.items.join(',') + ' needs ' + JSON.stringify(source.callerPermissions || []));
    });
    lines.push('Actions (' + plugin.actions.length + '):');
    plugin.actions.forEach(function(action) {
      lines.push(' ' + action.name + ' needs ' + JSON.stringify(action.callerPermissions || []));
    });
  }
  var others = (typeof Pebble.enumeratePlugins === 'function' ? Pebble.enumeratePlugins() : []).filter(function(p) { return p.uuid !== HA; });
  lines.push('Other plugins: ' + (others.map(function(p) { return p.name; }).join(', ') || 'none'));
  lines.push('Watch: ' + watch.width + 'x' + watch.height + (watch.color ? ' colour' : ' b/w') + (watch.mic ? ', mic' : ''));
  permissionLines(function(permissions) {
    text('Plugin & permissions', 'Permissions:\n' + permissions.join('\n') + '\n\n' + lines.join('\n'), screen);
  });
}

function entitiesMenu() {
  var plugin = haPlugin();
  if (!plugin) { return statusScreen(); }
  var rows = [];
  plugin.sources.forEach(function(source) {
    if (source.category !== 'home') { return; }
    source.items.forEach(function(item) {
      rows.push({
        title: item,
        subtitle: 'home/' + item + ' · ' + actionsFor('home', item).length + ' actions',
        select: function() { sourceScreen('home', item); }
      });
    });
  });
  menu('Entities', rows);
}

function weatherMenu() {
  var size = iconSize();
  menu('Weather', [
    { title: 'From the HA plugin', subtitle: 'everything, pictures at ' + size.w + 'px',
      select: function() { sourceScreen('weather', 'location', { iconPixelSize: size, showSource: true }); } },
    { title: 'Preferred source', subtitle: 'no plugin named: whoever the phone picks',
      select: function() { sourceScreen('weather', 'location', { anyPlugin: true, showSource: true, title: 'Preferred weather' }); } },
    { title: 'Without pictures', subtitle: 'no iconPixelSize: no icon or image',
      select: function() { sourceScreen('weather', 'location', { showSource: true, title: 'Weather, no pictures' }); } },
    { title: 'Small pictures', subtitle: '26x30 asked: pictures 26px',
      select: function() { sourceScreen('weather', 'location', { iconPixelSize: { w: 26, h: 30 }, properties: ['name', 'condition', 'hourly_condition', 'daily_condition'], title: 'Weather, 26px' }); } },
    { title: 'Current only', subtitle: 'properties: temperature, condition',
      select: function() { sourceScreen('weather', 'location', { properties: ['name', 'temperature', 'condition'], title: 'Weather, current' }); } },
    { title: 'Watch weather view', subtitle: 'what the watch\'s own weather needs',
      select: function() { sourceScreen('weather', 'location', { properties: ['name', 'temperature', 'condition_code', 'daily_high', 'daily_low', 'daily_condition_code', 'daily_sunrise', 'daily_sunset', 'sunrise', 'sunset'], title: 'For the watch' }); } }
  ]);
}

function ask(action, words) {
  var args = action === 'send_to_agent' ? { message: words } : { text: words };
  var screen = text(action, 'You: ' + words + '\n\nWaiting for the assistant…');
  var started = Date.now();
  Pebble.invokeAction({ plugin: HA, action: action, args: args }).then(function(result) {
    var ms = Date.now() - started;
    var reply = result.ok ? 'Assistant: ' + (result.text || '(nothing)') : (result.code || 'ERROR') + ': ' + (result.message || '');
    if (screens[screen.id]) { text(action, 'You: ' + words + '\n\n' + reply + '\n\n(' + ms + 'ms)\n' + json(result), screen); }
  });
}

function dictate(action) {
  if (!watch.mic) { return status('This watch has no microphone'); }
  var screen = menu('Dictate', [{ title: 'Listening…', subtitle: 'speak on the watch' }]);
  dictationDone = function(words) {
    if (!words) { return status('Nothing was heard'); }
    ask(action, words);
  };
  send({ cmd: CMD.DICTATE, screen: screen.id });
}

function assistantMenu() {
  menu('Assistant', [
    { title: 'agent/configured', subtitle: 'what Index checks first', select: function() { sourceScreen('agent', 'configured'); } },
    { title: 'Ask: temperature', subtitle: 'ask_assistant', select: function() { ask('ask_assistant', 'What is the temperature inside?'); } },
    { title: 'Ask: lights on?', subtitle: 'send_to_agent', select: function() { ask('send_to_agent', 'Which lights are on?'); } },
    { title: 'Follow up', subtitle: 'ask_assistant "and outside?" (same conversation)', select: function() { ask('ask_assistant', 'And outside?'); } },
    { title: 'New conversation', subtitle: 'ask_assistant new_conversation=true', select: function() {
      invoke('ask_assistant', { text: 'Hello', new_conversation: true }, function(result) { text('New conversation', json(result)); });
    } },
    { title: 'Dictate', subtitle: 'ask_assistant with your words', select: function() { dictate('ask_assistant'); } },
    { title: 'Dictate (agent)', subtitle: 'send_to_agent with your words', select: function() { dictate('send_to_agent'); } },
    { title: 'Empty message', subtitle: 'send_to_agent {} should be INVALID_ARGS', select: function() { invoke('send_to_agent', {}); } }
  ]);
}

/**
 * Calls that should be refused. They use shared entities where there are
 * some, so each gets past "not shared" to the check it is meant for.
 */
function errorMenu() {
  var screen = menu('Error cases', []);
  var subscription = Pebble.subscribeToSource({
    plugin: HA,
    category: 'home',
    item: 'entity',
    properties: ['name'],
    onData: function(envelope) {
      subscription.unsubscribe();
      var first = {};
      (envelope.instances || []).forEach(function(instance) {
        var domain = instance.instanceId.split('.')[0];
        if (!first[domain]) { first[domain] = instance.instanceId; }
      });
      if (screens[screen.id]) { errorRowsFor(first, screen); }
    },
    onError: function() {
      subscription.unsubscribe();
      if (screens[screen.id]) { errorRowsFor({}, screen); }
    }
  });
}

function errorRowsFor(first, screen) {
  var light = first.light || first.switch || 'light.not_shared';
  // [label, action, args, what should happen]
  var cases = [
    ['Unknown action', 'no_such_action', {}, 'INVALID_REQUEST'],
    ['Unshared entity', 'toggle', { instanceId: 'light.not_shared_by_tester' }, 'PERMISSION_DENIED'],
    ['No instanceId', 'toggle', {}, 'INVALID_ARGS'],
    ['Missing percent', 'set_brightness', { instanceId: light }, 'INVALID_ARGS'],
    ['Percent as text', 'set_brightness', { instanceId: light, percent: 'lots' }, 'INVALID_ARGS'],
    ['Bad service name', 'call_service', { instanceId: light, service: 'Turn On!' }, 'INVALID_ARGS'],
    ['Service not allowed', 'call_service', { instanceId: light, service: 'reload' }, 'PERMISSION_DENIED'],
    ['Target in data', 'call_service', { instanceId: light, service: 'turn_on', data: { entity_id: 'light.everything' } }, 'OK, on this light only'],
    ['Unlock via call_service', 'call_service', { instanceId: first.lock || 'lock.not_shared', service: 'unlock' }, 'PERMISSION_DENIED'],
    ['Toggle a lock', 'toggle', { instanceId: first.lock || 'lock.not_shared' }, 'INVALID_ARGS if locked'],
    ['Unlock (hold)', 'unlock', { instanceId: first.lock || 'lock.not_shared' }, 'refused unless Apps Can Unlock'],
    ['Disarm (hold)', 'alarm_disarm', { instanceId: first.alarm_control_panel || 'alarm_control_panel.not_shared' }, 'refused unless Apps Can Unlock'],
    ['Light as a climate', 'set_temperature', { instanceId: light, temperature: 21 }, 'INVALID_ARGS'],
    ['Assistant, no text', 'ask_assistant', {}, 'INVALID_ARGS']
  ];
  var rows = cases.map(function(c) {
    function run() { invoke(c[1], c[2], function(result) { text(c[0], 'Expected: ' + c[3] + '\n\n' + json(result)); }); }
    return {
      title: c[0],
      subtitle: 'expect ' + c[3] + ' · ' + c[1] + ' ' + argsLabel(c[2]),
      select: function() {
        if (DANGEROUS[c[1]]) { return status('Hold select to really ' + c[1].replace('_', ' ')); }
        run();
      },
      hold: run
    };
  });
  rows.push({ title: 'Removed source', subtitle: 'weather/hour should fail', select: function() { sourceScreen('weather', 'hour'); } });
  rows.push({ title: 'Unknown source', subtitle: 'home/nothing', select: function() { sourceScreen('home', 'nothing'); } });
  rows.push({ title: 'Undeclared property', subtitle: 'home/light asking for "bogus"', select: function() {
    sourceScreen('home', 'light', { properties: ['bogus'], title: 'light: bogus' });
  } });
  menu('Error cases', rows, screen);
}

function allSourcesMenu() {
  var plugin = haPlugin();
  if (!plugin) { return statusScreen(); }
  var rows = [];
  plugin.sources.forEach(function(source) {
    source.items.forEach(function(item) {
      rows.push({
        title: source.category + '/' + item,
        subtitle: Object.keys(source.properties || {}).length + ' properties, every ' + (source.suggestedRefreshIntervalSec || '?') + 's',
        select: function() { sourceScreen(source.category, item, { iconPixelSize: source.category === 'weather' ? iconSize() : undefined }); },
        hold: function() { text(source.category + '/' + item, json(source)); }
      });
    });
  });
  menu('All sources', rows);
}

function allActionsMenu() {
  var plugin = haPlugin();
  if (!plugin) { return statusScreen(); }
  menu('All actions', plugin.actions.map(function(action) {
    return {
      title: action.name,
      subtitle: (action.targets || []).join(' ') || 'no targets',
      select: function() {
        if ((action.targets || []).length === 0) { return menu(action.name, actionRows([action], null)); }
        // Pick an instance of the first source it targets
        var parts = action.targets[0].split('/');
        sourceScreen(parts[0], parts[1], {
          title: action.name + ': pick',
          onPick: function(instance) { menu(action.name, actionRows([action], instance)); }
        });
      },
      hold: function() { text(action.name, json(action)); }
    };
  }));
}

// ---- Home, the way the app shows it ------------------------------------------
//
// The shared entities as the Home Assistant WS app lists them: the name with
// the state under it. Select opens the entity's details page, built from its
// own home/<item> source and following it while it is open. Holding select
// does its quick action, as the app's EntityService.quickAction does, and
// opens the details where there is none.

//! Which home/<item> each domain is served under, as in the plugin's entities.js
var ITEM_BY_DOMAIN = {
  light: 'light', switch: 'switch', input_boolean: 'switch', fan: 'switch', automation: 'switch',
  siren: 'switch', humidifier: 'switch', remote: 'switch', sensor: 'sensor', number: 'sensor',
  input_number: 'sensor', counter: 'sensor', binary_sensor: 'binary_sensor', climate: 'climate',
  water_heater: 'climate', cover: 'cover', valve: 'cover', lock: 'lock', media_player: 'media_player',
  person: 'person', device_tracker: 'person', scene: 'scene', script: 'scene', button: 'scene',
  input_button: 'scene', alarm_control_panel: 'alarm'
};

//! The app toggles these from a list (automations too, its default)
var TOGGLES = {
  light: true, switch: true, input_boolean: true, fan: true, humidifier: true, siren: true,
  remote: true, automation: true
};

//! And runs or presses these
var ACTIVATES = { scene: true, script: true, button: true, input_button: true };

//! In the app's order, with Home Assistant's AlarmControlPanelEntityFeature bit for each
var ARM_MODES = [['away', 'Arm Away', 2], ['home', 'Arm Home', 1], ['night', 'Arm Night', 4],
  ['vacation', 'Arm Vacation', 32], ['custom_bypass', 'Arm Custom', 16]];

//! CoverEntityFeature, which valves share for these four
var COVER_OPEN = 1, COVER_CLOSE = 2, COVER_POSITION = 4, COVER_STOP = 8;

var HVAC_MODES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

function domainOf(instance) { return instance.instanceId.split('.')[0]; }

function nameOf(instance) { return propertyText(instance, 'name') || instance.instanceId; }

function boolOf(instance, name) {
  var shapes = instance && instance.properties && instance.properties[name];
  return shapes && shapes.boolean ? shapes.boolean.value : null;
}

function timeOf(instance, name) {
  var shapes = instance && instance.properties && instance.properties[name];
  return shapes && shapes.timestamp ? timeText(shapes.timestamp.value) : '';
}

function humanize(state) {
  var words = String(state).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

//! "On > 14:02", the way the app puts the state and when it changed
function stateLine(state, instance) {
  var since = timeOf(instance, 'last_changed');
  return state + (since ? ' > ' + since : '');
}

/**
 * Call an action the way the app calls a service: a short buzz when it
 * worked, and the banner with the code and a double buzz when it did not.
 * Quiet ones (a live selector following the dial) only show the banner.
 */
function act(action, args, onDone, quiet) {
  function done(result) {
    log(action + ' ' + JSON.stringify(args) + ' -> ' + JSON.stringify(result));
    if (result.ok) {
      if (!quiet) { buzz(VIBE.SHORT); }
    } else {
      status((result.code || 'ERROR') + ': ' + (result.message || ''), quiet ? VIBE.NONE : VIBE.DOUBLE);
    }
    if (onDone) { onDone(result); }
  }
  try {
    Pebble.invokeAction({ plugin: HA, action: action, args: args }).then(done, function(err) {
      done({ ok: false, code: 'REJECTED', message: String(err && err.message || err) });
    });
  } catch (e) {
    done({ ok: false, code: 'THROWN', message: String(e) });
  }
}

//! A row that only acts on a long press, like the rest of the tester
function holdRow(title, subtitle, action, args) {
  return {
    title: title + ' (hold)',
    subtitle: subtitle,
    select: function() { status('Hold select to really ' + action.replace('_', ' ')); },
    hold: function() { act(action, args); }
  };
}

/**
 * The entity's quick action, as the app's quickAction picks it. False when
 * it has none in the state it is in, and nothing was done. Unlocking and
 * disarming never happen from a list: the details page has them.
 */
function quickAction(instance) {
  var id = instance.instanceId;
  var domain = domainOf(instance);
  var state = propertyText(instance, 'state');
  if (state === 'Unavailable' || state === 'Unknown') { return false; }
  var target = { instanceId: id };
  if (TOGGLES[domain]) { act('toggle', target); return true; }
  if (ACTIVATES[domain]) { act('activate', target); return true; }
  if (domain === 'cover' || domain === 'valve') {
    // Open or close by what it is now; set_on opens without the open
    // action's asking, and refuses a garage door, gate or door
    var open = boolOf(instance, 'on');
    if (open === null || !supports(instance, open ? COVER_CLOSE : COVER_OPEN)) { return false; }
    act('set_on', { instanceId: id, on: !open });
    return true;
  }
  if (domain === 'lock') {
    if (state !== 'Unlocked' && state !== 'Open') { return false; }
    act('lock', target);
    return true;
  }
  if (domain === 'alarm_control_panel') {
    if (state !== 'Disarmed') { return false; }
    // The first mode it has, as the app picks it
    var modes = ARM_MODES.filter(function(mode) { return supports(instance, mode[2]); });
    if (modes.length === 0) { return false; }
    act('alarm_arm', { instanceId: id, mode: modes[0][0] });
    return true;
  }
  if (domain === 'select' || domain === 'input_select') {
    act('call_service', { instanceId: id, service: 'select_next' });
    return true;
  }
  if (domain === 'counter') {
    act('call_service', { instanceId: id, service: 'increment' });
    return true;
  }
  return false;
}

/**
 * A number selector for a details page. `follow(instance)` is the value the
 * entity has now; the page passes it on while the selector is open. `call(v)`
 * is [action, args] for a value. Select calls it and closes on success;
 * `live` calls it as the dial settles, as the app does for lights.
 */
function dial(page, options) {
  function run(value, onDone, quiet) {
    var call = options.call(value);
    act(call[0], call[1], onDone, quiet);
  }
  var selector = numberSelector({
    title: options.title,
    unit: options.unit,
    value: options.follow(page.instance),
    min: options.min,
    max: options.max,
    step: options.step,
    decimals: options.decimals,
    bar: true,
    onChange: options.live ? function(value) { run(value, null, true); } : null,
    onSet: function(value) {
      // Left up on failure so the value can be tried again
      run(value, function(result) { if (result.ok) { closeScreen(selector); } });
    }
  });
  selector.onClose = function() {
    if (page.selector === selector) { page.selector = null; }
  };
  page.selector = selector;
  page.follow = options.follow;
}

function temperatureUnit(instance) {
  var shapes = instance.properties.current_temperature || instance.properties.target_temperature;
  var unit = shapes && shapes.numericValue && shapes.numericValue.unit;
  return /F/.test(unit || '') ? '°F' : '°C';
}

//! A heat_cool thermostat's range
function rangeOf(instance) {
  var low = numberOf(instance, 'target_temp_low');
  var high = numberOf(instance, 'target_temp_high');
  return low !== null && high !== null ? { low: low, high: high } : null;
}

function hvacMenu(instance) {
  var current = propertyText(instance, 'hvac_mode');
  var screen = menu('HVAC Mode', (listOf(instance, 'hvac_modes') || HVAC_MODES).map(function(mode) {
    return {
      title: humanize(mode),
      subtitle: humanize(mode) === current ? 'Current' : '',
      select: function() {
        act('set_hvac_mode', { instanceId: instance.instanceId, hvac_mode: mode }, function(result) {
          if (result.ok) { closeScreen(screen); }
        });
      }
    };
  }));
}

/**
 * The details pages, one per item, modelled on the app's pages under
 * src/js/app/pages/entity/. Each builds its rows from the newest instance;
 * their handlers read page.instance so they never act on an old one.
 */
var PAGES = {
  light: function(instance, page) {
    var id = instance.instanceId;
    var on = boolOf(instance, 'on');
    var modes = listOf(instance, 'color_modes');
    var rows = [{
      title: nameOf(instance),
      subtitle: stateLine(propertyText(instance, 'on'), instance),
      select: function() { act('toggle', { instanceId: id }); }
    }];
    // onoff alone cannot dim, and the plugin would refuse
    var dims = !modes || modes.some(function(mode) { return mode !== 'onoff'; });
    if (dims) {
      rows.push({
        title: 'Brightness',
        subtitle: on ? numberOf(instance, 'brightness') + '%' : 'NA',
        select: function() {
          dial(page, {
            title: 'Brightness', unit: '%', min: 0, max: 100, step: 1, live: true,
            follow: function(now) { return boolOf(now, 'on') ? numberOf(now, 'brightness') : 0; },
            call: function(value) { return ['set_brightness', { instanceId: id, percent: value }]; }
          });
        }
      });
    }
    // color_temp only comes while the light is on in that mode
    var temp = (instance.properties.color_temp && instance.properties.color_temp.numericValue) ||
      (modes && modes.indexOf('color_temp') !== -1 ? {} : null);
    if (temp) {
      // No action of its own: call_service turn_on carries it
      var min = temp.min !== undefined ? temp.min : 2000;
      var max = temp.max !== undefined ? temp.max : 6500;
      rows.push({
        title: 'Color Temperature',
        subtitle: on && temp.value !== undefined ? temp.value + 'K' : 'NA',
        select: function() {
          dial(page, {
            title: 'Color Temp', unit: 'K', min: min, max: max, step: 50, live: true,
            follow: function(now) {
              var value = numberOf(now, 'color_temp');
              return value !== null ? value : Math.round((min + max) / 2);
            },
            call: function(value) {
              return ['call_service', { instanceId: id, service: 'turn_on', data: { color_temp_kelvin: value } }];
            }
          });
        }
      });
    }
    return rows;
  },

  switch: function(instance, page) {
    var id = instance.instanceId;
    var rows = [{
      title: nameOf(instance),
      subtitle: stateLine(propertyText(instance, 'on'), instance),
      select: function() { act('toggle', { instanceId: id }); }
    }];
    if (instance.properties.speed) {
      rows.push({
        title: 'Speed',
        subtitle: propertyText(instance, 'speed'),
        select: function() {
          dial(page, {
            title: 'Speed', unit: '%', min: 0, max: 100, step: 1,
            follow: function(now) { return numberOf(now, 'speed'); },
            call: function(value) {
              return ['call_service', { instanceId: id, service: 'set_percentage', data: { percentage: value } }];
            }
          });
        }
      });
    }
    if (domainOf(instance) === 'automation') {
      rows.push({ title: 'Trigger', subtitle: 'activate', select: function() { act('activate', { instanceId: id }); } });
    }
    return rows;
  },

  sensor: function(instance) {
    var rows = [{ title: 'Value', subtitle: propertyText(instance, 'value') }];
    if (instance.properties.device_class) {
      rows.push({ title: 'Device class', subtitle: propertyText(instance, 'device_class') });
    }
    rows.push({ title: 'Last changed', subtitle: timeOf(instance, 'last_changed') });
    return rows;
  },

  binary_sensor: function(instance) {
    var rows = [{ title: 'State', subtitle: propertyText(instance, 'state') }];
    if (instance.properties.device_class) {
      rows.push({ title: 'Device class', subtitle: propertyText(instance, 'device_class') });
    }
    rows.push({ title: 'Last changed', subtitle: timeOf(instance, 'last_changed') });
    return rows;
  },

  person: function(instance) {
    return [
      { title: 'Zone', subtitle: propertyText(instance, 'zone') },
      { title: 'Since', subtitle: timeOf(instance, 'since') }
    ];
  },

  scene: function(instance) {
    var id = instance.instanceId;
    var domain = domainOf(instance);
    var pressed = domain === 'button' || domain === 'input_button';
    var rows = [{
      title: pressed ? 'Press' : 'Run',
      subtitle: nameOf(instance),
      select: function() { act('activate', { instanceId: id }); }
    }];
    if (boolOf(instance, 'running')) {
      rows.push({ title: 'Stop', subtitle: 'running now', select: function() { act('set_on', { instanceId: id, on: false }); } });
    }
    rows.push({ title: pressed ? 'Last pressed' : 'Last run', subtitle: timeOf(instance, 'last_run') || 'never' });
    return rows;
  },

  cover: function(instance, page) {
    var id = instance.instanceId;
    var position = numberOf(instance, 'position');
    var rows = [
      { title: nameOf(instance), subtitle: stateLine(propertyText(instance, 'state') + (position !== null ? ' ' + position + '%' : ''), instance) },
    ];
    if (supports(instance, COVER_OPEN)) {
      rows.push({
        title: 'Open',
        subtitle: 'hold: the open action, which asks',
        select: function() { act('set_on', { instanceId: id, on: true }); },
        hold: function() { act('open', { instanceId: id }); }
      });
    }
    if (supports(instance, COVER_CLOSE)) { rows.push({ title: 'Close', select: function() { act('close', { instanceId: id }); } }); }
    if (supports(instance, COVER_STOP)) { rows.push({ title: 'Stop', select: function() { act('stop', { instanceId: id }); } }); }
    if (position !== null && supports(instance, COVER_POSITION)) {
      rows.push({
        title: 'Position',
        subtitle: position + '%',
        select: function() {
          dial(page, {
            title: 'Position', unit: '%', min: 0, max: 100, step: 1,
            follow: function(now) { return numberOf(now, 'position'); },
            call: function(value) { return ['set_position', { instanceId: id, position: value }]; }
          });
        }
      });
    }
    return rows;
  },

  climate: function(instance, page) {
    var id = instance.instanceId;
    var fahrenheit = temperatureUnit(instance) === '°F';
    // The thermostat's own step, else the frontend's defaults as the app has them
    var step = numberOf(instance, 'temperature_step') || (fahrenheit ? 1 : 0.5);
    var target = instance.properties.target_temperature && instance.properties.target_temperature.numericValue;
    var min = target && target.min !== undefined ? target.min : (fahrenheit ? 45 : 7);
    var max = target && target.max !== undefined ? target.max : (fahrenheit ? 95 : 35);
    function temperatureDial(title, follow, call) {
      dial(page, { title: title, unit: '°', min: min, max: max, step: step, decimals: step % 1 ? 1 : 0, follow: follow, call: call });
    }
    var rows = [{
      title: nameOf(instance),
      subtitle: stateLine(propertyText(instance, 'summary'), instance),
      select: function() { act('toggle', { instanceId: id }); }
    }];
    if (instance.properties.current_temperature) {
      rows.push({ title: 'Current', subtitle: propertyText(instance, 'current_temperature') });
    }
    var range = rangeOf(instance);
    if (target) {
      rows.push({
        title: 'Target',
        subtitle: target.value + '°',
        select: function() {
          temperatureDial('Target', function(now) { return numberOf(now, 'target_temperature'); },
            function(value) { return ['set_temperature', { instanceId: id, temperature: value }]; });
        }
      });
    } else if (range) {
      // Each end keeps the other where it is now
      rows.push({
        title: 'Low',
        subtitle: range.low + '°',
        select: function() {
          temperatureDial('Low', function(now) { var r = rangeOf(now); return r && r.low; }, function(value) {
            var r = rangeOf(page.instance) || range;
            return ['set_temperature', { instanceId: id, target_temp_low: value, target_temp_high: r.high }];
          });
        }
      }, {
        title: 'High',
        subtitle: range.high + '°',
        select: function() {
          temperatureDial('High', function(now) { var r = rangeOf(now); return r && r.high; }, function(value) {
            var r = rangeOf(page.instance) || range;
            return ['set_temperature', { instanceId: id, target_temp_low: r.low, target_temp_high: value }];
          });
        }
      });
    }
    if (domainOf(instance) === 'climate') {
      rows.push({ title: 'HVAC Mode', subtitle: propertyText(instance, 'hvac_mode'), select: function() { hvacMenu(page.instance); } });
    }
    if (instance.properties.hvac_action) {
      rows.push({ title: 'Action', subtitle: propertyText(instance, 'hvac_action') });
    }
    return rows;
  },

  media_player: function(instance, page) {
    var id = instance.instanceId;
    var playing = boolOf(instance, 'playing');
    var off = propertyText(instance, 'state') === 'Off';
    var rows = [{
      title: nameOf(instance),
      subtitle: stateLine(propertyText(instance, 'state'), instance),
      select: function() { act('set_playing', { instanceId: id, playing: !playing }); }
    }];
    if (instance.properties.title) { rows.push({ title: 'Title', subtitle: propertyText(instance, 'title') }); }
    if (instance.properties.artist) { rows.push({ title: 'Artist', subtitle: propertyText(instance, 'artist') }); }
    rows.push(
      { title: playing ? 'Pause' : 'Play', select: function() { act('set_playing', { instanceId: id, playing: !playing }); } },
      { title: 'Next', select: function() { act('next_track', { instanceId: id }); } },
      { title: 'Previous', select: function() { act('previous_track', { instanceId: id }); } }
    );
    if (instance.properties.volume) {
      rows.push({
        title: 'Volume',
        subtitle: propertyText(instance, 'volume'),
        select: function() {
          dial(page, {
            title: 'Volume', unit: '%', min: 0, max: 100, step: 1,
            follow: function(now) { return numberOf(now, 'volume'); },
            call: function(value) { return ['set_volume', { instanceId: id, percent: value }]; }
          });
        }
      });
    }
    rows.push({ title: off ? 'Turn On' : 'Turn Off', select: function() { act('set_on', { instanceId: id, on: off }); } });
    return rows;
  },

  lock: function(instance) {
    var id = instance.instanceId;
    return [
      { title: nameOf(instance), subtitle: stateLine(propertyText(instance, 'state'), instance) },
      { title: 'Lock', select: function() { act('lock', { instanceId: id }); } },
      holdRow('Unlock', 'needs Apps Can Unlock', 'unlock', { instanceId: id }),
      holdRow('Open', 'unlatch, needs Apps Can Unlock', 'open', { instanceId: id })
    ];
  },

  alarm: function(instance) {
    var id = instance.instanceId;
    var rows = [{ title: nameOf(instance), subtitle: stateLine(propertyText(instance, 'state'), instance) }];
    ARM_MODES.forEach(function(mode) {
      if (!supports(instance, mode[2])) { return; }
      rows.push({ title: mode[1], subtitle: 'alarm_arm ' + mode[0], select: function() { act('alarm_arm', { instanceId: id, mode: mode[0] }); } });
    });
    rows.push(holdRow('Disarm', 'needs Apps Can Unlock', 'alarm_disarm', { instanceId: id }));
    return rows;
  },

  //! Whatever has no page of its own, from home/entity
  entity: function(instance) {
    var id = instance.instanceId;
    var rows = [
      { title: 'State', subtitle: stateLine(propertyText(instance, 'state'), instance) },
      { title: 'Domain', subtitle: propertyText(instance, 'domain') }
    ];
    if (boolOf(instance, 'on') !== null) {
      rows.push({ title: 'Toggle', subtitle: boolOf(instance, 'on') ? 'on now' : 'off now', select: function() { act('toggle', { instanceId: id }); } });
    }
    rows.push({
      title: 'Every action…',
      subtitle: 'including ones meant for other kinds',
      select: function() { menu('All on ' + id, actionRows(entityActions(), instance)); }
    });
    return rows;
  }
};

/**
 * An entity's details page. It follows the entity's own home/<item> source
 * while it is open, redrawing when it changes and passing the new value to
 * an open selector, and stops when the watch leaves it.
 */
function entityPage(entity) {
  var id = entity.instanceId;
  var item = ITEM_BY_DOMAIN[domainOf(entity)] || 'entity';
  var build = PAGES[item];
  var title = clean(nameOf(entity), 30);
  var page = { instance: entity, selector: null, follow: null };
  var screen = menu(title, []);
  var subscription = null;
  var last = '';

  function rawRow() {
    return {
      title: 'Properties & tests',
      subtitle: 'home/' + item + ' raw, and its actions',
      select: function() { instanceScreen('home', item, page.instance); }
    };
  }

  function draw(instance) {
    var rows;
    if (instance) {
      page.instance = instance;
      rows = build(instance, page).concat([rawRow()]);
      if (page.selector && screens[page.selector.id]) { page.selector.value(page.follow(instance)); }
    } else {
      rows = [{ title: 'Not shared now', subtitle: id + ' is not in home/' + item }];
    }
    var signature = JSON.stringify(rows.map(function(r) { return [r.title, r.subtitle]; }));
    if (signature === last) {
      screen.rows = rows;
      return;
    }
    last = signature;
    menu(title, rows, screen);
  }

  function start() {
    try {
      subscription = Pebble.subscribeToSource({
        plugin: HA,
        category: 'home',
        item: item,
        onData: function(envelope) {
          if (!screens[screen.id]) { return; }
          var found = null;
          ((envelope && envelope.instances) || []).forEach(function(instance) {
            if (instance.instanceId === id) { found = instance; }
          });
          draw(found);
        },
        onError: function(err) {
          log('home/' + item + ' error ' + JSON.stringify(err));
          last = '';
          if (screens[screen.id]) { menu(title, errorRows(err, restart), screen); }
        }
      });
    } catch (e) {
      menu(title, errorRows({ code: 'THROWN', message: String(e) }), screen);
    }
  }

  function restart() {
    if (subscription) { subscription.unsubscribe(); }
    last = '';
    menu(title, [], screen);
    start();
  }

  screen.onClose = function() { if (subscription) { subscription.unsubscribe(); } };
  start();
}

function homeMenu() {
  sourceScreen('home', 'entity', {
    title: 'Home',
    // Weather has its own menu, and nothing to do here
    filter: function(instance) { return domainOf(instance) !== 'weather'; },
    row: function(instance) {
      return {
        title: nameOf(instance),
        subtitle: propertyText(instance, 'state'),
        select: function() { entityPage(instance); },
        hold: function() { if (!quickAction(instance)) { entityPage(instance); } }
      };
    }
  });
}

function mainMenu() {
  menu('HA Plugin Tester', [
    { title: 'Home', subtitle: 'your entities, as the app shows them', select: homeMenu },
    { title: 'Plugin & permissions', subtitle: 'is it there, what it needs', select: statusScreen },
    { title: 'Entities', subtitle: 'every home/* source and its actions', select: entitiesMenu },
    { title: 'Weather', subtitle: 'current, series, pictures, sun', select: weatherMenu },
    { title: 'Assistant', subtitle: 'ask_assistant, send_to_agent', select: assistantMenu },
    { title: 'All sources', subtitle: 'straight from the manifest', select: allSourcesMenu },
    { title: 'All actions', subtitle: 'straight from the manifest', select: allActionsMenu },
    { title: 'Error cases', subtitle: 'what should be refused', select: errorMenu }
  ], screens[0]);
}

// ---- From the watch ----------------------------------------------------------

Pebble.addEventListener('ready', function() {
  screens[0] = { id: 0 };
  log('ready; plugin ' + (haPlugin() ? 'found' : 'not found'));
});

Pebble.addEventListener('appmessage', function(e) {
  var p = e.payload || {};
  if (p.ready !== undefined) {
    watch = { width: p.width || 144, height: p.height || 168, color: !!p.color, mic: !!p.mic };
    screens[0] = screens[0] || { id: 0 };
    mainMenu();
    return;
  }
  if (p.dictation !== undefined) {
    var done = dictationDone;
    dictationDone = null;
    if (done) { done(p.dictation); }
    return;
  }
  if (p.change !== undefined || p.set !== undefined) {
    var selector = screens[p.change !== undefined ? p.change : p.set];
    var report = selector && (p.change !== undefined ? selector.onChange : selector.onSet);
    try {
      if (report) { report(p.value); }
    } catch (err) {
      log('selector failed: ' + (err && err.stack || err));
      status('Tester error: ' + err);
    }
    return;
  }
  if (p.back !== undefined) {
    var gone = screens[p.back];
    delete screens[p.back];
    if (gone && gone.onClose) { gone.onClose(); }
    return;
  }
  var id = p.sel !== undefined ? p.sel : p.longsel;
  var screen = screens[id];
  if (!screen || !screen.rows) { return; }
  var row = screen.rows[p.index];
  if (!row) { return; }
  var handler = p.sel !== undefined ? row.select : (row.hold || row.select);
  try {
    if (handler) { handler(); }
  } catch (err) {
    log('handler failed: ' + (err && err.stack || err));
    status('Tester error: ' + err);
  }
});
