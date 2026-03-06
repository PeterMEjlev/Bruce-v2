'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const BruceAssistant = require('../src/index');

const bruce = new BruceAssistant({
  picovoiceKey: process.env.PICOVOICE_ACCESS_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  wakeWordPath: path.resolve(
    __dirname,
    '..',
    process.env.WAKE_WORD_PATH || 'wake-words/Bruce_en_windows_v3_0_0.ppn'
  ),
  systemPrompt:
    process.env.BRUCE_SYSTEM_PROMPT ||
    `You are Bruce, a knowledgeable and friendly AI assistant for a home brewing setup.
You have access to tools to check fermentation status, control temperature, and read sensor data.
Keep responses concise and conversational — you are speaking, not writing.`,
  voice: process.env.BRUCE_VOICE || 'alloy',
  sensitivity: 0.6,
});

// ── Register brewing functions ───────────────────────────────────────────────

bruce.registerFunction(
  'get_fermentation_status',
  'Get the current fermentation status including temperature, gravity reading, and days elapsed for a vessel',
  {
    type: 'object',
    properties: {
      vessel_id: {
        type: 'string',
        description: 'The fermentation vessel identifier, e.g. "primary" or "secondary"',
      },
    },
    required: ['vessel_id'],
  },
  async ({ vessel_id }) => {
    // TODO: Replace with real Raspberry Pi sensor reads via HTTP/IPC
    return JSON.stringify({
      vessel: vessel_id,
      temperature_celsius: 18.5,
      original_gravity: 1.062,
      current_gravity: 1.015,
      days_elapsed: 7,
      status: 'active fermentation',
    });
  }
);

bruce.registerFunction(
  'set_temperature_target',
  'Set the target temperature for a fermentation vessel heating unit',
  {
    type: 'object',
    properties: {
      vessel_id: {
        type: 'string',
        description: 'The fermentation vessel identifier',
      },
      target_celsius: {
        type: 'number',
        description: 'Target temperature in Celsius',
      },
    },
    required: ['vessel_id', 'target_celsius'],
  },
  async ({ vessel_id, target_celsius }) => {
    // TODO: Send command to Python backend / Raspberry Pi
    console.log(`[Bruce] Setting ${vessel_id} target to ${target_celsius}°C`);
    return `Temperature target for ${vessel_id} set to ${target_celsius}°C`;
  }
);

bruce.registerFunction(
  'get_brew_schedule',
  'Get the current brew batch info and upcoming tasks',
  {
    type: 'object',
    properties: {},
    required: [],
  },
  async () => {
    // TODO: Pull from your brewing app's database
    return JSON.stringify({
      current_batch: 'Pale Ale',
      brew_date: '2026-02-28',
      expected_fg: 1.010,
      next_task: 'Dry hop addition in 2 days',
      estimated_completion: '2026-03-14',
    });
  }
);

// ── Event listeners ──────────────────────────────────────────────────────────

bruce.on('ready', () => console.log('[Bruce] Ready. Say "Bruce" to activate.'));
bruce.on('wake', () => console.log('[Bruce] Wake word detected! Listening...'));
bruce.on('listening', () => process.stdout.write('[Bruce] Listening'));
bruce.on('thinking', () => console.log('\n[Bruce] Processing...'));
bruce.on('speaking', () => console.log('[Bruce] Speaking...'));
bruce.on('idle', () => console.log('[Bruce] Back to idle. Say "Bruce" again anytime.\n'));
bruce.on('functionCall', (name, args) =>
  console.log(`[Bruce] Calling: ${name}`, JSON.stringify(args))
);
bruce.on('error', (err) => console.error('[Bruce] Error:', err));

// ── Start ────────────────────────────────────────────────────────────────────

bruce.start().catch((err) => {
  console.error('Failed to start Bruce:', err.message);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n[Bruce] Shutting down...');
  await bruce.stop();
  process.exit(0);
});
