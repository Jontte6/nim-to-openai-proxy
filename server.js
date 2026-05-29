// server.js - Hybrid OpenAI ↔ NIM Proxy
// Fixed: stream death, JSON vomit, silent buffer loss, missing error propagation

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { StringDecoder } = require('string_decoder');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/v1/models') {
    return next();
  }

  const auth = req.headers.authorization?.trim();
  const expected = `Bearer ${process.env.CLIENT_AUTH_KEY}`;

  if (!auth || auth !== expected) {
    return res.status(403).json({
      error: {
        message: 'Forbidden',
        type: 'authentication_error',
        code: 403
      }
    });
  }

  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Toggles - env-configurable for phone-editing at 2am
const SHOW_REASONING = process.env.SHOW_REASONING === 'true';
const ENABLE_THINKING_MODE = process.env.ENABLE_THINKING_MODE === 'true';

const MAX_TOKENS_LIMIT = 65536;

if (SHOW_REASONING) console.log('[CONFIG] Reasoning display: ENABLED');
if (ENABLE_THINKING_MODE) console.log('[CONFIG] Thinking mode: ENABLED');

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/nemotron-3-super-120b-a12b',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-3.5': 'qwen/qwen3.5-397b-a17b',
  'gpt-4-turbo': 'moonshotai/kimi-k2.6',
  'gpt-4o': 'deepseek-ai/deepseek-v4-pro',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'gemini-turbo': 'meta/llama-3.3-70b-instruct',
  'gemini-turbo?': 'abacusai/dracarys-llama-3.1-70b-instruct',
  'gpt-3.5o': 'nvidia/nemotron-mini-4b-instruct',
  'gpt-4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.1': 'z-ai/glm-5.1',
  'mistral': 'mistralai/mistral-large-3-675b-instruct-2512',
  'mistral-turbo': 'mistralai/mistral-medium-3.5-128b',
  'mistral-pro': 'mistralai/mistral-small-4-119b-2603',
  'mistral-nemo': 'mistralai/mistral-nemotron',
  'mistral-fast': 'mistralai/ministral-14b-instruct-2512',
  'google-light': 'google/gemma-4-31b-it',
  'google-lightest': 'google/gemma-2-2b-it',
  'google-lighter': 'google/gemma-3n-e4b-it',
  'm2.7': 'minimaxai/minimax-m2.7',
  'step-3.5-flash': 'stepfun-ai/step-3.5-flash'
};

const FALLBACK_MODELS = [
  'mistralai/mistral-medium-3.5-128b',
  'mistralai/mistral-small-4-119b-2603',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'google/gemma-4-31b-it'
];

// You can delete this part from your fork if you don't trust it since it calls on a discord webhook.
// The webhook is an env variable, and is just used to check if the models are valid.

const SKIP_VALIDATION = process.env.SKIP_VALIDATION === 'true';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const SKIP_VALIDATION_MODELS = ['deepseek-ai/deepseek-v4-pro'];

async function sendDiscordAlert(invalidModels) {
  if (!DISCORD_WEBHOOK_URL) return;

  const embed = {
    title: '⚠️ NIM Proxy: Model Validation Failed',
    description: `${invalidModels.length} model(s) failed validation. Check NIM catalog for deprecations.`,
    color: 0xff4444,
    timestamp: new Date().toISOString(),
    fields: invalidModels.map(m => ({
      name: `\`${m.alias}\``,
      value: `Backend: \`${m.nimId}\`\nError: \`${m.error}\``,
      inline: true
    }))
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed],
      username: 'NIM Proxy Monitor'
    });

    console.log('[DISCORD] Alert sent.');
  } catch (err) {
    console.error('[DISCORD] Failed to send alert:', err.message);
  }
}

async function validateModels() {
  if (SKIP_VALIDATION) {
    console.log('[VALIDATION] Skipped (SKIP_VALIDATION=true)');
    return;
  }

  console.log('[VALIDATION] Checking model availability...');
  const invalid = [];

  for (const [alias, nimId] of Object.entries(MODEL_MAPPING)) {
    if (SKIP_VALIDATION_MODELS.includes(nimId)) {
      console.log(`[VALIDATION] ⊘ ${alias} → ${nimId} (skipped — known slow)`);
      continue;
    }

    let succeeded = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await axios.post(
          `${NIM_API_BASE}/chat/completions`,
          {
            model: nimId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1
          },
          {
            headers: {
              Authorization: `Bearer ${NIM_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          }
        );

        console.log(`[VALIDATION] ✓ ${alias} → ${nimId}`);
        succeeded = true;
        break;

      } catch (err) {
        const isTimeout =
          err.code === 'ECONNABORTED' ||
          err.message?.includes('timeout');

        const isLastAttempt = attempt === 2;

        if (isTimeout && !isLastAttempt) {
          console.warn(`[VALIDATION] Timeout on ${alias}, retrying...`);
          continue;
        }

        if (isLastAttempt) {
          const status = err.response?.status;
          const msg =
            err.response?.data?.error?.message || err.message;

          console.error(
            `[VALIDATION] ✗ ${alias} → ${nimId} | ${status} ${msg}`
          );

          invalid.push({
            alias,
            nimId,
            error: `${status} ${msg}`
          });
        }
      }
    }
  }

  if (invalid.length > 0) {
    console.warn(`[VALIDATION] ${invalid.length} model(s) failed:`);

    for (const m of invalid) {
      console.warn(`  - ${m.alias}: ${m.error}`);
    }

    await sendDiscordAlert(invalid);

  } else {
    console.log('[VALIDATION] All models valid.');
  }
}

if (!SKIP_VALIDATION) {
  validateModels().catch(err => {
    console.error('[VALIDATION] Check failed:', err.message);
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'nim-proxy'
    }))
  });
});

async function callWithFallback(baseRequest, models) {
  for (const model of models) {
    try {
      const res = await axios.post(
        `${NIM_API_BASE}/chat/completions`,
        { ...baseRequest, model },
        {
          headers: {
            Authorization: `Bearer ${NIM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: baseRequest.stream ? 'stream' : 'json',
          timeout: 180000
        }
      );

      return { response: res, model };

    } catch (err) {
      console.warn(
        `[FALLBACK] Model failed: ${model}`,
        err.response?.status,
        err.response?.data?.error?.message || err.message
      );
    }
  }

  throw new Error('All models failed');
}

app.post('/v1/chat/completions', async (req, res) => {
  let streamEndedCleanly = false;

  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream
    } = req.body;

    const primaryModel =
      MODEL_MAPPING[model] ||
      'nvidia/llama-3.3-nemotron-super-49b-v1.5';

    const modelChain = [
      primaryModel,
      ...FALLBACK_MODELS
    ];

    const baseRequest = {
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: Math.min(
        max_tokens ?? 2048,
        MAX_TOKENS_LIMIT
      ),
      stream: stream || false,
      extra_body: ENABLE_THINKING_MODE
        ? {
            chat_template_kwargs: {
              thinking: true
            }
          }
        : undefined
    };

    const {
      response,
      model: usedModel
    } = await callWithFallback(baseRequest, modelChain);

    console.log('[PROXY] Model used:', usedModel);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // FIX: Proper UTF-8-safe decoding without corrupting split multibyte chars
      const decoder = new StringDecoder('utf8');

      let buffer = '';
      let reasoningOpen = false;
      let doneSent = false;

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;

        if (line.includes('[DONE]')) {
          if (!doneSent) {
            res.write('data: [DONE]\n\n');
            doneSent = true;
          }

          streamEndedCleanly = true;
          return;
        }

        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta;

          if (delta) {
            let content = delta.content || '';
            const reasoning = delta.reasoning_content;

            if (SHOW_REASONING) {
              if (reasoning && !reasoningOpen) {
                content = `<thinking>\n${reasoning.replace(/\n/g, '\\n')}`;
                reasoningOpen = true;

              } else if (reasoning) {
                content = reasoning.replace(/\n/g, '\\n');
              }

              if (delta.content && reasoningOpen) {
                content += `\n</thinking>\n\n${delta.content}`;
                reasoningOpen = false;
              }
            }

            delta.content = content;
            delete delta.reasoning_content;
          }

          res.write(`data: ${JSON.stringify(data)}\n\n`);

        } catch (parseErr) {
          console.warn(
            '[STREAM] Skipped invalid JSON line:',
            line.slice(0, 100)
          );
        }
      };

      response.data.on('data', chunk => {
        // Proper UTF-8-safe decoding
        buffer += decoder.write(chunk);

        const lines = buffer.split('\n');

        // Keep incomplete line for next chunk
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      });

      response.data.on('end', () => {
        // Flush remaining UTF-8 decoder bytes
        buffer += decoder.end();

        // Process any leftover lines
        if (buffer.trim()) {
          console.warn(
            '[STREAM] Processing leftover buffer at end:',
            buffer.slice(0, 100)
          );

          for (const line of buffer.split('\n')) {
            processLine(line);
          }
        }

        if (!doneSent) {
          res.write('data: [DONE]\n\n');
        }

        streamEndedCleanly = true;
        res.end();
      });

      response.data.on('error', err => {
        console.error('[STREAM] Upstream error:', err.message);

        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: 'Stream interrupted',
                type: 'stream_error'
              }
            })}\n\n`
          );

          res.write('data: [DONE]\n\n');
          res.end();
        }
      });

      req.on('close', () => {
        if (!streamEndedCleanly) {
          console.warn('[STREAM] Client disconnected prematurely');
        }

        if (response.data && !response.data.destroyed) {
          response.data.destroy();
        }
      });

    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,

        choices: (response.data.choices || []).map((choice, i) => {
          let content = choice.message?.content || '';

          if (
            SHOW_REASONING &&
            choice.message?.reasoning_content
          ) {
            const safeReasoning =
              choice.message.reasoning_content.replace(/\n/g, '\\n');

            content =
              `<thinking>\n${safeReasoning}\n</thinking>\n\n${content}`;
          }

          return {
            index: i,
            message: {
              role: choice.message?.role || 'assistant',
              content,
              tool_calls: choice.message?.tool_calls
            },
            finish_reason: choice.finish_reason || 'stop'
          };
        }),

        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    console.error('[PROXY] Fatal error:', error.message);
    console.error('[PROXY] NIM response:', error.response?.data);

    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({
        error: {
          message: error.message,
          type: 'invalid_request_error',
          code: error.response?.status || 500
        }
      });

    } else if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          error: {
            message: error.message,
            type: 'proxy_error'
          }
        })}\n\n`
      );

      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`[PROXY] Hybrid proxy running on port ${PORT}`);
  console.log(`[PROXY] Max tokens limit: ${MAX_TOKENS_LIMIT}`);
});
