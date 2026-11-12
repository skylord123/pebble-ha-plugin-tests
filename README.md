# Home Assistant WS plugin tests

Two Pebble apps for trying out the plugin in [Home Assistant WS](https://github.com/skylord123/pebble-home-assistant-ws) ([PR #96](https://github.com/skylord123/pebble-home-assistant-ws/pull/96)): a watch app that reaches every source and action the plugin has, and a watchface that shows its weather and entities the way any other face would.

Every push builds both. The newest pbws are always on the [latest release](https://github.com/skylord123/pebble-ha-plugin-tests/releases/tag/latest): open one on the phone with the Pebble app to install it. Each build gets its own version, so a sideload always replaces the watch binary.

## Before you start

- The Core Devices Pebble app with **Plugins / permissions preview** turned on (Settings → Plugins). Version 1.17 or later shows the permission states and the clearer errors.
- A build of Home Assistant WS from the `plugins-poc` branch, set up with your Home Assistant, and a few entities shared under **Shared with Other Apps** on its settings page.
- For the assistant tests, **Share with Apps** under Voice. For unlocking, **Apps Can Unlock**.

When you install either app, the Pebble app asks to let it use your location. The plugin requires `Location` of everything that reads it, because it serves the watch's own weather for your weather locations. The tester also asks to call the plugin's actions, and for its `Unlock` and `Assistant` permissions.

## HA Plugin Tester (watch app)

Its menus are built from what the plugin declares, so a source or action added to the plugin shows up without a change here. Select opens a row; holding select shows the raw reply where there is one, except on an entity, where it does the entity's quick action as in the app (the raw reply is under **Id** once it is open). **Home** is the exception: it shows your entities the way the Home Assistant WS app does, so you can try the plugin the way an app would use it.

| Menu | Tests |
| --- | --- |
| Home | The shared entities from `home/entity` (weather left out), live, with the name and the state under it. Select opens the entity's details page; holding select does its quick action, as in the app: lights, switches, fans, automations and the like toggle, scenes, scripts and buttons run, covers open or close, an unlocked lock locks, a disarmed alarm arms in the first mode it supports, selects go to their next option and counters count up. Anything else, or a lock that is locked or an alarm that is armed, opens its details instead. A short buzz means it worked; an error shows its code and message with a double buzz. |
| Plugin & permissions | Whether the plugin is installed, every source and action with the permissions it requires of callers, other plugins on the phone, and what `Pebble.permissions.query` says for `Location`, `InvokeAction`, `Unlock` and `Assistant`. |
| Entities | Every `home/*` source as a live list (it redraws when the plugin sends an update). Open an instance for each of its properties, and the actions that target that source with sample arguments. **Every action…** tries all of them on it, including ones meant for other kinds of entity. |
| Weather | `weather/location` from the plugin by its UUID, from whichever plugin the phone prefers, without pictures, with 26 px pictures, current conditions only, and only what the watch's own weather reads. Open an instance and pick `condition` for its picture (hold for the icon), any series for its values one by one, and an hourly or daily condition for that hour's or day's picture. Instances whose id is a UUID are your weather locations. |
| Assistant | `agent/configured`, `ask_assistant` and `send_to_agent` with sample questions, a follow-up in the same conversation, a fresh conversation, dictation into either one on watches with a microphone, and an empty message. |
| All sources | Every source the plugin declares, `agent/configured` included. Hold for its declaration. |
| All actions | Every action the plugin declares. Pick one, then an instance, then a set of arguments. Hold for its declaration. |
| Error cases | Calls that should be refused, each saying what it expects: unknown actions and sources, unshared entities, missing or wrong arguments, services `call_service` must refuse, a target in `data` (dropped), unlocking a lock through `call_service`, and the unlock and disarm gates. |

`unlock`, `open` and `alarm_disarm` act on real things, so anywhere in the tester they only run when select is held.

### Details pages

Each page follows the entity's own `home/<item>` source while it is open, and stops when you leave it. They are modelled on the app's pages:

| Kind | Rows |
| --- | --- |
| Light | The light (select toggles), Brightness, only when it can dim, and Color Temperature when it has that colour mode. Brightness uses `set_brightness`; colour temperature has no action of its own, so it goes through `call_service` `turn_on`. Both follow the dial as you turn it. |
| Switch, fan, automation | The entity (select toggles), Speed for fans (`call_service` `set_percentage`), Trigger for automations (`activate`). |
| Cover, valve | The state and position, Open (`set_on`; hold for the `open` action, which garage doors, gates and doors need), Close, Stop, and Position (`set_position`), each only when its `supported_features` has it. |
| Climate, water heater | The summary (select toggles), Current, Target (`set_temperature` in the thermostat's own steps, or 0.5° and 1°F without one), or Low and High for a thermostat keeping a range, HVAC Mode (`set_hvac_mode`, offering the thermostat's own modes) and what it is doing. |
| Media player | The state (select plays or pauses), Title, Artist, Play/Pause, Next, Previous, Volume (`set_volume`), and Turn On or Off. |
| Lock | The state, Lock, and Unlock and Open on a long press. |
| Alarm | The state, each arm mode it supports (`alarm_arm`), and Disarm on a long press. |
| Scene, script, button | Run or Press (`activate`), Stop for a running script, and when it last ran. |
| Sensor, binary sensor, person | The value or state, device class and when it changed; for a person the zone and since when. |
| Anything else | The state and domain, Toggle when it has an on and off, and **Every action…**. |

The last row of every page, **Properties & tests**, opens the same raw view the Entities menu has for that entity.

Brightness, colour temperature, speed, position, temperature and volume are set with a number selector like the app's: big digits and a bar, up and down to adjust (hold to repeat, faster the longer you hold over a big range), select to set. It buzzes and closes when the value took, and stays up with the error when it did not. A value that changes in Home Assistant while it is open shows up in it, except for a second after you press a button.

## HA Plugin Face (watchface)

The time and date, then Home Assistant's weather from the plugin's first `weather/location` instance: the condition picture the plugin draws (its `image` shape, asked for at the size the face has room for), temperature, condition and place, high and low, sunrise and sunset, a few of the coming hours, and the first two shared entities. A failed source shows its error code in place of the condition.

## Building

With the [Pebble SDK](https://developer.repebble.com/sdk/) installed:

```sh
scripts/build.sh
```

The pbws land in `dist/`. `pebble build` alone makes a pbw the Pebble app treats as a legacy app, which may not use plugins at all; `scripts/manifest_v2.py` marks it `"manifestVersion": 2`.

The pictures from the plugin are 4 bits a pixel with a palette. `shared/bitmap.c` turns them into a bitmap the watch can draw, and on aplite, which has no palettes, into black and white. Both apps link to it.
