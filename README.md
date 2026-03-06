# Bruce — AI Voice Assistant

Standalone Node.js voice assistant for a home brewing setup. Say **"Bruce"** to activate, then speak naturally. Bruce responds with voice and can call custom functions (e.g. read fermentation sensors, set temperature targets).

Built to run standalone or drop into an Electron app.

---

## How it works

```
Mic (continuous PCM16 16kHz)
  │
  ├─[idle]──────> Porcupine (offline wake word "Bruce")
  │                   │ detected
  ├─[listening]──────> Stream audio → OpenAI Realtime API (WebSocket)
  │                   │ silence detected
  ├─[thinking]──────> OpenAI processes, optionally calls functions
  │                   │ response ready
  └─[speaking]──────> TTS audio plays → back to idle
```

---

## Prerequisites

### Node.js
Version 18 or later.

### SoX (audio processor)
Required by the microphone capture library.

**Windows:** Download from [sourceforge.net/projects/sox](http://sourceforge.net/projects/sox) and add to PATH.

**Linux / Raspberry Pi:**
```bash
sudo apt-get install sox libsox-fmt-all libasound2-dev
```

**macOS:**
```bash
brew install sox
```

### API Keys
- **Picovoice Access Key** — free at [console.picovoice.ai](https://console.picovoice.ai/)
- **OpenAI API Key** — must have access to the Realtime API (`gpt-4o-realtime-preview`)

---

## Wake Word Setup

1. Create a free account at [console.picovoice.ai](https://console.picovoice.ai/)
2. Copy your **Access Key** from the console dashboard
3. Go to **Wake Word** → **Train a new wake word**
4. Enter `Bruce` as the phrase, select your target platform:
   - Windows: `windows`
   - Linux / Raspberry Pi: `raspberry-pi`
   - macOS: `mac`
5. Download the generated `.ppn` file
6. Place it in the `wake-words/` directory
7. Set `WAKE_WORD_PATH` in your `.env` to match the filename

> Note: `.ppn` files are platform-specific. Use the correct build for each machine.

---

## Installation

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

---

## Running

```bash
npm start
# or
node examples/basic.js
```

Say **"Bruce"** — you'll see `Wake word detected!` in the console. Then ask something like:

> "What's the fermentation status of my primary vessel?"
> "Set the primary to eighteen degrees."
> "What's on the brew schedule?"

---

## API

### `new BruceAssistant(config)`

| Option | Type | Required | Description |
|---|---|---|---|
| `picovoiceKey` | string | yes | Picovoice access key |
| `openaiKey` | string | yes | OpenAI API key |
| `wakeWordPath` | string | yes | Path to `.ppn` file |
| `systemPrompt` | string | no | Custom system instructions |
| `voice` | string | no | TTS voice: `alloy` (default), `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `sensitivity` | number | no | Wake word sensitivity 0.0–1.0 (default `0.5`) |
| `micDevice` | string | no | Mic device override (e.g. `plughw:1` on Linux) |

### `bruce.start()` → `Promise<void>`
Connects to OpenAI, starts Porcupine, starts microphone.

### `bruce.stop()` → `Promise<void>`
Graceful shutdown.

### `bruce.registerFunction(name, description, parameters, handler)`
Register a tool Bruce can call during conversation.

```js
bruce.registerFunction(
  'get_temperature',
  'Get the current temperature of a fermentation vessel',
  {
    type: 'object',
    properties: {
      vessel_id: { type: 'string', description: 'Vessel identifier' }
    },
    required: ['vessel_id']
  },
  async ({ vessel_id }) => {
    const temp = await myBrewingAPI.getTemperature(vessel_id);
    return `Current temperature: ${temp}°C`;
  }
);
```

### Events

| Event | Payload | Description |
|---|---|---|
| `ready` | — | Connected and listening for wake word |
| `wake` | — | Wake word detected |
| `listening` | — | Streaming audio to OpenAI |
| `thinking` | — | Audio committed, waiting for response |
| `speaking` | — | Playing TTS audio |
| `idle` | — | Response finished, back to wake word mode |
| `functionCall` | `(name, args)` | A function is being executed |
| `error` | `Error` | Something went wrong |

---

## Electron Integration

`BruceAssistant` must run in the **Electron main process** (not the renderer) because it uses native Node.js addons and spawns SoX child processes.

```js
// main.js
const { BruceAssistant } = require('./bruce/src/index');

const bruce = new BruceAssistant({
  picovoiceKey: process.env.PICOVOICE_ACCESS_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  wakeWordPath: path.join(__dirname, 'wake-words/Bruce_en_windows_v3_0_0.ppn'),
});

// Register functions that call your Python backend
bruce.registerFunction('get_fermentation_status', '...', schema, async (args) => {
  const res = await fetch(`http://localhost:5000/api/fermentation/${args.vessel_id}`);
  return JSON.stringify(await res.json());
});

// Forward Bruce state to renderer via IPC for UI updates
bruce.on('wake', () => mainWindow.webContents.send('bruce:wake'));
bruce.on('listening', () => mainWindow.webContents.send('bruce:listening'));
bruce.on('speaking', () => mainWindow.webContents.send('bruce:speaking'));
bruce.on('idle', () => mainWindow.webContents.send('bruce:idle'));

app.whenReady().then(() => bruce.start());
app.on('before-quit', () => bruce.stop());
```

> When packaging with `electron-builder`, run `electron-rebuild` after `npm install` to recompile native addons against Electron's Node ABI. Add `wake-words/**/*.ppn` to `extraResources`.

---

## Smoke Tests

**1. Verify Porcupine loads (no mic needed):**
```js
const { Porcupine } = require('@picovoice/porcupine-node');
const p = new Porcupine(process.env.PICOVOICE_ACCESS_KEY, ['./wake-words/Bruce.ppn'], [0.5]);
console.log('frameLength:', p.frameLength); // 512
p.release();
```

**2. Verify mic captures audio:**
```js
const recorder = require('node-record-lpcm16');
const rec = recorder.record({ sampleRate: 16000, channels: 1, audioType: 'raw' });
let total = 0;
rec.stream().on('data', (c) => { total += c.length; process.stdout.write(`\r${total} bytes`); });
setTimeout(() => { rec.stop(); console.log('\nMic OK'); process.exit(0); }, 3000);
```

**3. Verify OpenAI WebSocket connects:**
```js
require('dotenv').config();
const WebSocket = require('ws');
const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
});
ws.on('message', (d) => {
  const e = JSON.parse(d);
  if (e.type === 'session.created') { console.log('WebSocket OK'); ws.close(); }
});
```
