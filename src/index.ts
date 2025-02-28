export default {
  async fetch(request, env) {
    // Check if Database binding is available
    if (!env.Database) {
      console.error("Database binding is missing or undefined.");
      return new Response("Database not configured", { status: 500 });
    }

    const url = new URL(request.url);

    // Validate webhook subscription (GET request)
    if (request.method === "GET" && url.searchParams.get("hub.mode") === "subscribe") {
      if (url.searchParams.get("hub.verify_token") === "24Spiritbulb") {
        return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Reject non-POST methods
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      console.error("Invalid JSON:", error);
      return new Response("Invalid JSON", { status: 400 });
    }

    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      return new Response("No message received", { status: 400 });
    }

    const userMessage = message?.text?.body?.trim() || "";
    const senderId = message?.from;

    if (!userMessage || !senderId) {
      return new Response("Invalid message format", { status: 400 });
    }

    // Insert the user message into D1 storage
    try {
      await env.Database.execute(`
        INSERT INTO messages (sender_id, message)
        VALUES (?, ?)
      `, [senderId, userMessage]);
      console.log("Message inserted into Database:", { senderId, userMessage });
    } catch (error) {
      console.error("Error inserting into Database:", error.message, error.stack);
      return new Response("Database error", { status: 500 });
    }

    // Retrieve the user's previous messages (context) from D1
    let previousMessages = [];
    try {
      const result = await env.Database.execute(`
        SELECT message FROM messages
        WHERE sender_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `, [senderId]);

      previousMessages = result.rows.map(row => row.message);
    } catch (error) {
      console.error("Error retrieving messages from Database:", error.message, error.stack);
    }

    // Add a first message identifier if no previous messages exist
    if (previousMessages.length === 0) {
      previousMessages = ["First message from user"];
    }

    // Combine previous messages with the current message for AI context
    const aiContext = previousMessages.join("\n") + "\nUser: " + userMessage;

    // AI Persona definition
    const shikoPersona = {
      name: "Shiko",
      description: "A campus girl who knows everything about university life.",
      knowledge: "Knows about best food spots, hidden study areas, and where to find things on campus.",
      behavior: "Friendly, casual, a little playful, but very informative."
    };

    // Generate the AI response
    let reply = "Sorry, I didn't get that.";
    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: `You are ${shikoPersona.name}, ${shikoPersona.description}. ${shikoPersona.knowledge}. ${shikoPersona.behavior}.` },
          { role: "user", content: aiContext }
        ]
      });
      reply = aiResponse?.response?.trim() || reply;
    } catch (error) {
      console.error("AI API Error:", error.message, error.stack);
      reply = "I'm having trouble thinking right now. Try again later.";
    }

    // Send the response back via WhatsApp
    try {
      const whatsappResponse = await fetch(`https://graph.facebook.com/v17.0/${env.WABA_ID}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.WHATSAPP_API_KEY}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: senderId,
          text: { body: reply }
        })
      });
      const whatsappResult = await whatsappResponse.json();
      console.log("WhatsApp API Response:", whatsappResult);
    } catch (error) {
      console.error("WhatsApp API Error:", error.message, error.stack);
    }

    return new Response("OK", { status: 200 });
  }
};
