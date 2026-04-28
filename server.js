// server.js - OpenAI to NVIDIA NIM API Proxy (FIXED)

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// NVIDIA config
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/nemotron-3-super-120b-a12b',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v4-pro',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking',
  'gpt-4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.1': 'z-ai/glm-5.1',
  'glm-4.7': 'z-ai/glm4.7',
  'mistral': 'mistralai/devstral-2-123b-instruct-2512',
  'mistral-turbo': 'mistralai/magistral-small-2506',
  'mistral-pro': 'mistralai/mistral-small-4-119b-2603',
  'google-light': 'google/gemma-3-27b-it',
  'google-lightest': 'google/gemma-2-2b-it',
  'google-lighter': 'google/gemma-3n-e4b-it'
};

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy'
  });
});

// Models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(model => ({
      id: model,
      object: 'model',
      created: Date.now(),
      owned_by: 'nim-proxy'
    }))
  });
});

// Chat endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-8b-instruct';

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.8,
      max_tokens: max_tokens || 4096,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000,
        responseType: stream ? 'stream' : 'json'
      }
    );

    // ================= STREAM =================
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      response.data.on('data', (chunk) => {
        const text = chunk.toString();

        if (text.includes('[DONE]')) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.write(text + '\n\n');
      });

      response.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });

      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });

    // ================= NON-STREAM =================
    } else {

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: nimModel,
        choices: (response.data.choices || []).map((choice, i) => ({
          index: i,
          message: {
            role: choice.message?.role || 'assistant',
            content: choice.message?.content ?? ''
          },
          finish_reason: 'stop'
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      console.log("Sending response:", JSON.stringify(openaiResponse).slice(0, 200));

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Connection', 'close');
      res.status(200).send(JSON.stringify(openaiResponse));
    }

  } catch (error) {
    console.error('Proxy error:', error.message);

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Fallback
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
  console.log(`Proxy running on port ${PORT}`);
});
