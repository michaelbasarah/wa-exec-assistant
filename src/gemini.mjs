/**
 * The smallest Gemini client that does the job: one REST call, no SDK. Returns the model's text.
 * Every caller takes this function as an injectable dependency, so tests never touch the network.
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export async function generate({ system, contents, json = false, schema, temperature = 0.2, maxOutputTokens = 2048 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const generationConfig = { temperature, maxOutputTokens };
  if (json) generationConfig.responseMimeType = "application/json";
  if (schema) generationConfig.responseSchema = schema;
  const resp = await fetch(`${API}/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig,
    }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

const TRANSCRIBE_PROMPT =
  "Transcribe this voice note verbatim. The speaker may use English or Indonesian, or mix them: keep the " +
  "original language, do not translate. Output ONLY the transcription. If it is silent, output nothing.";

/** Voice note ({ data: base64, mimeType }) → raw transcript text. */
export function transcribe(audio, gen = generate) {
  return gen({
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: audio.mimeType || "audio/ogg", data: audio.data } },
      { text: TRANSCRIBE_PROMPT },
    ] }],
    temperature: 0,
    maxOutputTokens: 1024,
  });
}
