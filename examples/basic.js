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
You can read temperatures from three pots (BK = Boil Kettle, MLT = Mash/Lauter Tun, HLT = Hot Liquor Tank), control heating elements and regulation on BK and HLT, and control two pumps (P1 and P2).
The MLT only has a temperature sensor — no heater. Regulation is a simple on/off thermostat that maintains a target temperature.
Keep responses concise and conversational — you are speaking, not writing.
After responding, the user can continue talking to you without repeating your name.
When the user says goodbye, stop, that's all, or otherwise indicates they are done, call the end_conversation function.`,
  voice: process.env.BRUCE_VOICE || 'alloy',
  sensitivity: 0.6,
});

// ── Register brewing functions ───────────────────────────────────────────────

// 1. Read temperature for a pot (BK, MLT, or HLT)
bruce.registerFunction(
  'read_temperature',
  'Read the current temperature in Celsius for a brewing pot',
  {
    type: 'object',
    properties: {
      pot: {
        type: 'string',
        enum: ['BK', 'MLT', 'HLT'],
        description: 'The pot to read: BK (Boil Kettle), MLT (Mash/Lauter Tun), or HLT (Hot Liquor Tank)',
      },
    },
    required: ['pot'],
  },
  async ({ pot }) => {
    // TODO: Replace with real sensor read from Raspberry Pi
    const mock = { BK: 98.2, MLT: 66.5, HLT: 75.0 };
    const temp = mock[pot] ?? 0;
    console.log(`[Bruce] Read temperature ${pot} → ${temp}°C`);
    return JSON.stringify({ pot, temperature_celsius: temp });
  }
);

// 2. Turn heating unit ON/OFF for a pot (BK or HLT)
bruce.registerFunction(
  'set_heater',
  'Turn the heating element ON or OFF for a pot',
  {
    type: 'object',
    properties: {
      pot: {
        type: 'string',
        enum: ['BK', 'HLT'],
        description: 'The pot: BK (Boil Kettle) or HLT (Hot Liquor Tank)',
      },
      state: {
        type: 'string',
        enum: ['ON', 'OFF'],
        description: 'Turn the heater ON or OFF',
      },
    },
    required: ['pot', 'state'],
  },
  async ({ pot, state }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Heater ${pot} → ${state}`);
    return `Heater for ${pot} turned ${state}`;
  }
);

// 3. Set heating efficiency for a pot (0–100%)
bruce.registerFunction(
  'set_heater_efficiency',
  'Set the heating element efficiency (power level) for a pot, from 0 to 100 percent',
  {
    type: 'object',
    properties: {
      pot: {
        type: 'string',
        enum: ['BK', 'HLT'],
        description: 'The pot: BK (Boil Kettle) or HLT (Hot Liquor Tank)',
      },
      efficiency: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Heating efficiency in percent (0–100)',
      },
    },
    required: ['pot', 'efficiency'],
  },
  async ({ pot, efficiency }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Heater ${pot} efficiency → ${efficiency}%`);
    return `Heater efficiency for ${pot} set to ${efficiency}%`;
  }
);

// 4. Turn regulation (REG) ON/OFF for a pot (BK or HLT)
bruce.registerFunction(
  'set_regulation',
  'Turn temperature regulation ON or OFF for a pot. When ON, the heater automatically turns on below target temp and off above it.',
  {
    type: 'object',
    properties: {
      pot: {
        type: 'string',
        enum: ['BK', 'HLT'],
        description: 'The pot: BK (Boil Kettle) or HLT (Hot Liquor Tank)',
      },
      state: {
        type: 'string',
        enum: ['ON', 'OFF'],
        description: 'Turn regulation ON or OFF',
      },
    },
    required: ['pot', 'state'],
  },
  async ({ pot, state }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Regulation ${pot} → ${state}`);
    return `Regulation for ${pot} turned ${state}`;
  }
);

// 5. Set target temperature for regulation (0–100°C)
bruce.registerFunction(
  'set_regulation_target',
  'Set the target temperature for regulation on a pot, from 0 to 100 degrees Celsius',
  {
    type: 'object',
    properties: {
      pot: {
        type: 'string',
        enum: ['BK', 'HLT'],
        description: 'The pot: BK (Boil Kettle) or HLT (Hot Liquor Tank)',
      },
      target_celsius: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Target temperature in Celsius (0–100)',
      },
    },
    required: ['pot', 'target_celsius'],
  },
  async ({ pot, target_celsius }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Regulation target ${pot} → ${target_celsius}°C`);
    return `Regulation target for ${pot} set to ${target_celsius}°C`;
  }
);

// 6. Turn pumps ON/OFF
bruce.registerFunction(
  'set_pump',
  'Turn a pump ON or OFF',
  {
    type: 'object',
    properties: {
      pump: {
        type: 'string',
        enum: ['P1', 'P2'],
        description: 'The pump: P1 (Pump 1) or P2 (Pump 2)',
      },
      state: {
        type: 'string',
        enum: ['ON', 'OFF'],
        description: 'Turn the pump ON or OFF',
      },
    },
    required: ['pump', 'state'],
  },
  async ({ pump, state }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Pump ${pump} → ${state}`);
    return `Pump ${pump} turned ${state}`;
  }
);

// 7. Set pump speed (0–100%)
bruce.registerFunction(
  'set_pump_speed',
  'Set the speed of a pump, from 0 to 100 percent',
  {
    type: 'object',
    properties: {
      pump: {
        type: 'string',
        enum: ['P1', 'P2'],
        description: 'The pump: P1 (Pump 1) or P2 (Pump 2)',
      },
      speed: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Pump speed in percent (0–100)',
      },
    },
    required: ['pump', 'speed'],
  },
  async ({ pump, speed }) => {
    // TODO: Send command to Raspberry Pi
    console.log(`[Bruce] Pump ${pump} speed → ${speed}%`);
    return `Pump ${pump} speed set to ${speed}%`;
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
