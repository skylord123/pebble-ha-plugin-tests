/*
 * HA Plugin Face, the phone half: reads Home Assistant's weather and the
 * first shared entities from the Home Assistant WS plugin, and sends the
 * face finished lines and the condition picture.
 */
var HA = '61ae3254-ce00-49db-aad8-23143f649b90';
var CHUNK = 600;

var sent = {};
var subscriptions = [];
var iconSize = 40;
var weatherError = '';
var entityError = '';

function log(text) { console.log('[face] ' + text); }

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
  function next() { queue.shift(); sending = false; pump(); }
  function attempt() {
    Pebble.sendAppMessage(message, next, function() {
      if (++tries < 4) { setTimeout(attempt, 400); } else { next(); }
    });
  }
  attempt();
}

//! Send only the lines that changed
function update(lines) {
  var message = {};
  Object.keys(lines).forEach(function(key) {
    if (sent[key] !== lines[key]) {
      message[key] = lines[key];
      sent[key] = lines[key];
    }
  });
  if (Object.keys(message).length > 0) { send(message); }
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
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xFF); }
  }
  return bytes;
}

function sendIcon(shape) {
  var key = shape ? shape.palette + shape.pixels : '';
  if (sent.icon === key) { return; }
  sent.icon = key;
  if (!shape) { return; }
  var pixels = base64Bytes(shape.pixels);
  send({ iconW: shape.width, iconH: shape.height, iconPal: base64Bytes(shape.palette) });
  for (var offset = 0; offset < pixels.length; offset += CHUNK) {
    send({ iconPx: pixels.slice(offset, offset + CHUNK), iconOff: offset });
  }
}

// ---- Reading the plugin ------------------------------------------------------

function text(instance, name) {
  var shapes = instance && instance.properties && instance.properties[name];
  if (!shapes) { return ''; }
  if (shapes.shortText) { return shapes.shortText.text; }
  if (shapes.numericValue) { return Math.round(shapes.numericValue.value) + (shapes.numericValue.unit || ''); }
  if (shapes.boolean) { return shapes.boolean.value ? 'on' : 'off'; }
  return '';
}

//! "54°F" as "54°": the face has no room for the unit
function short(value) { return String(value).replace(/°[CF]$/, '°'); }

function clock(seconds) {
  var d = new Date(seconds * 1000);
  return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
}

//! "13h 12° 15h 11° …" from the hourly series, from the hour we are in
function hoursLine(instance) {
  var shapes = instance.properties.hourly_temperature;
  var series = shapes && shapes.series;
  if (!series || !series.shortText) { return ''; }
  var now = Math.floor(Date.now() / 1000);
  var first = Math.floor((now - series.start) / series.stepSec);
  var parts = [];
  for (var i = first + 1; i < series.shortText.values.length && parts.length < 4; i += 2) {
    var value = series.shortText.values[i];
    if (value === null) { continue; }
    parts.push(new Date((series.start + i * series.stepSec) * 1000).getHours() + 'h ' + short(value));
  }
  return parts.join('  ');
}

function onWeather(envelope) {
  var instance = envelope.instances && envelope.instances[0];
  weatherError = '';
  if (!instance) {
    update({ err: 'No weather shared', place: '', temp: '--' });
    return;
  }
  var p = instance.properties;
  var hilo = [];
  if (p.high) { hilo.push('H ' + short(text(instance, 'high'))); }
  if (p.low) { hilo.push('L ' + short(text(instance, 'low'))); }
  if (p.sunrise && p.sunset) { hilo.push(clock(p.sunrise.timestamp.value) + '-' + clock(p.sunset.timestamp.value)); }
  update({
    err: entityError,
    place: text(instance, 'name'),
    temp: short(text(instance, 'temperature')) || '--',
    cond: text(instance, 'condition'),
    hilo: hilo.join(' · '),
    hours: hoursLine(instance)
  });
  sendIcon(p.condition && p.condition.image);
}

function onEntities(envelope) {
  entityError = '';
  var lines = (envelope.instances || []).filter(function(instance) {
    return instance.instanceId.indexOf('weather.') !== 0;
  }).slice(0, 2).map(function(instance) {
    return text(instance, 'name') + ': ' + text(instance, 'state');
  });
  update({ ent1: lines[0] || 'No entities shared', ent2: lines[1] || '', err: weatherError });
}

function failed(what) {
  return function(err) {
    var line = what + ' ' + (err.code || 'error');
    log(line + ': ' + (err.message || ''));
    if (what === 'Weather') { weatherError = line; } else { entityError = line; }
    update({ err: line });
  };
}

function subscribe() {
  subscriptions.forEach(function(subscription) { subscription.unsubscribe(); });
  subscriptions = [];
  sent = {};
  if (typeof Pebble.subscribeToSource !== 'function') {
    update({ err: 'No plugins here' });
    return;
  }
  subscriptions.push(Pebble.subscribeToSource({
    plugin: HA,
    category: 'weather',
    item: 'location',
    properties: ['name', 'temperature', 'condition', 'high', 'low', 'sunrise', 'sunset', 'hourly_temperature'],
    iconPixelSize: { w: iconSize, h: iconSize },
    onData: onWeather,
    onError: failed('Weather')
  }));
  subscriptions.push(Pebble.subscribeToSource({
    plugin: HA,
    category: 'home',
    item: 'entity',
    properties: ['name', 'state'],
    onData: onEntities,
    onError: failed('Entities')
  }));
}

Pebble.addEventListener('appmessage', function(e) {
  var p = e.payload || {};
  if (p.ready === undefined) { return; }
  iconSize = p.iconSize || 40;
  log('face ready, ' + iconSize + 'px pictures');
  subscribe();
});
