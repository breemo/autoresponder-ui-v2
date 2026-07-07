export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const webhookUrl = process.env.N8N_EVOLUTION_GATEWAY_URL;

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to call n8n",
    });
  }
}
