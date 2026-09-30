#!/usr/bin/env node
/**
 * caterer-ai-review.js - thin wrapper around ai-review.js for backward compatibility.
 *
 * Existing pipeline calls keep working unchanged; all logic lives in ai-review.js.
 *
 *   node scripts/caterer-ai-review.js --mode batch --job "Chef" --location "M1" --distance 20 --candidates-file <path>
 *   node scripts/caterer-ai-review.js --mode single --job "Chef" --title "Head Chef" --snippet "..."
 */
'use strict';

require('./ai-review.js').run();
