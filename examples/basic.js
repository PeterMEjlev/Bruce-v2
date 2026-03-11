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
Keep responses very concise and conversational — you are speaking, not writing.
After responding, the user can continue talking to you without repeating your name.

## CRITICAL RULE — announcing actions
When you need to call a function, ALWAYS briefly say what you are about to do BEFORE calling it. For example, say "Turning on the boil kettle heater" then call set_heater, or "Let me check the temperature" then call read_temperature. Keep the announcement to one short sentence. Do NOT wait for the function result to speak — announce first, call the function, then after getting the result you can share relevant details like readings.

## CRITICAL RULE — ending the conversation
Before generating ANY spoken reply, first evaluate whether the user is signaling the conversation is over. If the user's message does NOT contain a clear question or actionable request, and includes ANY of the following cues, you MUST call the end_conversation function:
- Farewell or gratitude: "thank you", "thanks", "goodbye", "bye", "see you", "cheers"
- Closure phrases: "that's it", "that's all", "I'm done", "I'm good", "all set", "no more", "never mind", "nothing else"
- Dismissals: "stop", "enough", "I don't need help", "not right now", "no thanks"
- Any combination of the above (e.g. "Thank you, that's it, I don't need any help")
When in doubt, call end_conversation. You may say a brief goodbye like "See you!" before calling it.`,
  voice: process.env.BRUCE_VOICE || 'ash',
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

// Transcript arrives asynchronously (Whisper runs parallel to the LLM response).
// We buffer status messages briefly after "thinking" fires, giving the transcript
// a short grace period to arrive first so [You] prints before [Bruce] Processing.
// If the transcript doesn't arrive in time, we flush and print status in real-time.
const TRANSCRIPT_GRACE_MS = 1500;
let msgQueue = [];
let waitingForTranscript = false;
let graceTimer = null;

function flushQueue() {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  waitingForTranscript = false;
  msgQueue.splice(0).forEach(m => console.log(m));
}

function queueOrLog(msg) {
  if (waitingForTranscript) { msgQueue.push(msg); }
  else { console.log(msg); }
}

bruce.on('ready', () => console.log('[Bruce] Ready. Say "Bruce" to activate.'));
bruce.on('wake', () => console.log('[Bruce] Wake word detected! Listening...'));
bruce.on('listening', () => {
  waitingForTranscript = true;
  msgQueue = [];
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  process.stdout.write('[Bruce] Listening\n');
});
bruce.on('transcript', (text) => {
  console.log(`[You] ${text}`);
  flushQueue();
});
bruce.on('thinking', () => {
  queueOrLog('[Bruce] Processing...');
  // Give the transcript a short window to arrive before flushing
  if (waitingForTranscript && !graceTimer) {
    graceTimer = setTimeout(flushQueue, TRANSCRIPT_GRACE_MS);
  }
});
bruce.on('speaking', () => queueOrLog('[Bruce] Speaking...'));
bruce.on('idle', () => {
  if (waitingForTranscript) flushQueue();
  console.log('[Bruce] Back to idle. Say "Bruce" again anytime.\n');
});
bruce.on('functionCall', (name, args) =>
  queueOrLog(`[Bruce] Calling: ${name} ${JSON.stringify(args)}`)
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
