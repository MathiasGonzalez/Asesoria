export interface EmailEnv {
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
}

export class EmailService {
  constructor(private env: EmailEnv) {}

  /** Sends an OTP verification email to the given address. */
  async sendOtp(to: string, code: string): Promise<void> {
    const subject = "Tu código de acceso — Adviser";
    const formattedCode = code.split("").join(" "); // e.g. "1 2 3 4 5 6"

    const text = [
      `Tu código de acceso es: ${code}`,
      "",
      "Este código expira en 10 minutos.",
      "Si no solicitaste este código, ignorá este mensaje.",
    ].join("\n");

    const html = `
      <div style="font-family:sans-serif;max-width:420px;margin:auto;padding:32px">
        <h2 style="color:#1e40af;margin-bottom:8px">Adviser</h2>
        <p style="color:#475569;margin-bottom:24px">Tu código de acceso es:</p>
        <div style="font-size:2.25rem;font-weight:700;letter-spacing:0.4em;background:#f1f5f9;
                    padding:20px;border-radius:10px;text-align:center;color:#0f172a">
          ${formattedCode}
        </div>
        <p style="color:#64748b;font-size:0.875rem;margin-top:20px">
          Este código expira en <strong>10 minutos</strong>.
        </p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
        <p style="color:#94a3b8;font-size:0.75rem">
          Si no solicitaste este código, ignorá este mensaje.
        </p>
      </div>`;

    await this.sendEmail(to, subject, text, html);
  }

  private async sendEmail(
    to: string,
    subject: string,
    text: string,
    html: string
  ): Promise<void> {
    const apiKey = this.env.EMAIL_API_KEY;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        from: this.env.EMAIL_FROM,
        to: [to],
        subject,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Email send failed (${res.status}): ${body}`);
    }
  }
}
