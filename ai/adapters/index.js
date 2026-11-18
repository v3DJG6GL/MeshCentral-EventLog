'use strict';
// API format adapters. get(format) -> adapter | null for 'openai-chat' | 'openai-responses' | 'anthropic'.
//
// Adapter interface (all synchronous except listModels/probe; none of them throws on bad server data):
//   format                                   the format id; raw replay blocks are tagged with it
//   buildRequest(ep, transcript, tools, opts) -> { url, path, headers, body(object) }
//       ep: { baseUrl, model, apiKey|null, maxOutputTokens, numCtx, ollamaNative }
//       transcript: { system, items: [ {role:'user',text} | {role:'assistant',text,calls:[{id,name,args,argsText}],raw}
//                                    | {role:'tool',results:[{callId,name,content,isError}]} ] }
//       raw (assistant items): { format, items:[provider-native blocks] } as returned by llm.stream; replayed
//                              verbatim only when raw.format equals the adapter's format.
//       tools: [{ name, description, parameters }] (empty -> no tools sent)
//       opts: { toolChoice:'auto'|'none', maxOutputTokens, stream (default true) }
//   createParser(emit, ep) -> { push(text), end() }      (ep only matters for openai-chat + ollamaNative)
//       emits {t:'text',d} {t:'call',id,name,argsText} {t:'raw',x} {t:'usage',in,out}
//             {t:'stop',reason:'end'|'tools'|'length'|'refusal'} {t:'error',message,code} {t:'malformed'}
//   parseNonStream(json, emit, ep)                        same events from a non-streamed JSON answer
//   classifyError(status, headers, bodyText) -> { code, retryable, retryAfterMs, toolsUnsupported, contextFull, message, status }
//   listModels(ep, deps) -> Promise<[{ id, ctx?, tools? }]>
//   probe(ep, deps) -> Promise<{ ok, tools: true|false|null, ctx: number|null, server: string|null, detail, code? }>
//       deps: { request(opts) } = ai/http.js request bound to the endpoint's pinned lookup / proxy agent.

const ADAPTERS = {
    'openai-chat': require('./openai_chat.js'),
    'openai-responses': require('./openai_responses.js'),
    'anthropic': require('./anthropic.js')
};

function get(format) { return Object.prototype.hasOwnProperty.call(ADAPTERS, format) ? ADAPTERS[format] : null; }

module.exports = { get, formats: Object.keys(ADAPTERS), ollama: require('./ollama.js') };
