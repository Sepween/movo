const API = "https://api.elevenlabs.io/v1";

export async function POST(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "Missing API key" }, { status: 500 });

  const form = await req.formData();
  if (form.get("action") === "speak") {
    const res = await fetch(`${API}/text-to-speech/${form.get("voiceId")}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: String(form.get("text") ?? ""),
        model_id: "eleven_multilingual_v2",
      }),
    });
    if (!res.ok) return Response.json({ error: await res.text() }, { status: res.status });
    return new Response(res.body, { headers: { "Content-Type": "audio/mpeg" } });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Audio file required" }, { status: 400 });
  }
  const out = new FormData();
  out.set("name", String(form.get("name") || "Keyboard voice"));
  out.append("files", file);
  const res = await fetch(`${API}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: out,
  });
  const data = await res.json();
  if (!res.ok) {
    return Response.json(
      { error: data?.detail?.message ?? data?.error ?? "Clone failed" },
      { status: res.status },
    );
  }
  return Response.json({ voiceId: data.voice_id });
}
