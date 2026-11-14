'use strict';
// The public variant never enters the private repository-update startup path.
require('./stdio-lifecycle').guard();
const {app} = require('electron');
app.setName('AI Hub Lite');
require('./user-profile');
const config = require('../src/core/config');
// The public defaults already select Lite with automatic work off. Avoid redundant device-file rewrites at startup.
require('./main');
