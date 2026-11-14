'use strict';
// Device profile (device-only `hub.profile`). 'full' is the default. 'lite' is the optional office-laptop mode for
// remote control and light work (e.g. an 8 GB laptop without a discrete GPU): no automatic local inference, no
// background hardware/GPU polling or autopilot, slower reconnect and share polling, and heavy binary analysis left to
// the desktop. Everything else (MCP hub, cloud/remote delegation, memory, sharing, updates) works the same.
const os = require('os');
const config = require('./config');

const LITE = { shareIntervalMin: 15, reconnectMs: 5 * 60 * 1000 };

function lite(cfg = config.load()) {
  return cfg.hub?.profile === 'lite';
}
// Automatic local model preparation runs only on a full-profile device that has not opted out.
function automaticPreparation(cfg = config.load()) {
  return !lite(cfg) && cfg.localRuntimes?.automaticPreparation !== false;
}
// Shown as a hint only; the user decides. 8 GB-class machines gain the most from the lite profile.
function describe(cfg = config.load()) {
  return { profile: lite(cfg) ? 'lite' : 'full', recommended: os.totalmem() <= 12 * 1024 ** 3 };
}

module.exports = { LITE, lite, automaticPreparation, describe };
