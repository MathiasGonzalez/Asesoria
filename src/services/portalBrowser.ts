/**
 * PortalBrowserService — automates DGI SIGA and BPS SUNA portals via Cloudflare
 * Browser Rendering API (@cloudflare/puppeteer).
 *
 * ⚠️  SELECTORS NOTE
 * The CSS selectors below are best-effort approximations derived from typical
 * ASP.NET WebForms government portals.  They MUST be verified against the live
 * sites using browser DevTools before deploying to production:
 *   • DGI SIGA: https://servicios.dgi.gub.uy/serviciosenlinea
 *   • BPS SUNA: https://www.bps.gub.uy/bps/index.jsp
 *
 * Adjust the `*_SELECTORS` constants and task URLs accordingly.
 */

import puppeteer from "@cloudflare/puppeteer";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Portal = "dgi" | "bps";

export type PortalTask =
  | "consulta_estado_cuenta"
  | "descarga_constancia"
  | "consulta_deuda";

export interface PortalCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface LoginResult {
  success: boolean;
  cookies?: PortalCookie[];
  /** Human-readable error, suitable for displaying to the user. */
  error?: string;
}

export interface TaskResult {
  success: boolean;
  /** Raw extracted data — callers may pipe this into an AI analysis step. */
  data?: { raw_text: string };
  /** Human-readable error. */
  error?: string;
}

// ---------------------------------------------------------------------------
// DGI SIGA — selectors & URLs
// TODO: verify with DevTools at https://servicios.dgi.gub.uy/serviciosenlinea
// ---------------------------------------------------------------------------

const DGI_LOGIN_URL =
  "https://servicios.dgi.gub.uy/serviciosenlinea";

const DGI_SELECTORS = {
  usernameInput:
    'input[name="rut"], input[id*="rut" i], input[name="usuario"], input[type="text"]:first-of-type',
  passwordInput:
    'input[name="pwd"], input[name="password"], input[type="password"]:first-of-type',
  submitButton:
    'button[type="submit"], input[type="submit"], a[id*="ingresar" i]',
  errorMessage:
    '.error, .ErrorMessage, [class*="error" i]:not(script), [id*="error" i]:not(script)',
  captchaIndicator:
    '.g-recaptcha, [class*="captcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
  loggedInIndicator:
    '.menu-lateral, [class*="menuUsuario" i], [id*="menuUsuario" i], .logged-in, [id*="bienvenido" i]',
};

// Task navigation URLs — to be verified against the live portal
const DGI_TASK_URLS: Record<PortalTask, string> = {
  consulta_estado_cuenta:
    "https://servicios.dgi.gub.uy/serviciosenlinea/GestionTributariaHabilitada/MisObligaciones",
  descarga_constancia:
    "https://servicios.dgi.gub.uy/serviciosenlinea/GestionTributariaHabilitada/ConstanciaSituacionFiscal",
  consulta_deuda:
    "https://servicios.dgi.gub.uy/serviciosenlinea/GestionTributariaHabilitada/DeudaFiscal",
};

// ---------------------------------------------------------------------------
// BPS SUNA — selectors & URLs
// TODO: verify with DevTools at https://www.bps.gub.uy/bps/index.jsp
// ---------------------------------------------------------------------------

const BPS_LOGIN_URL = "https://www.bps.gub.uy/bps/index.jsp";

const BPS_SELECTORS = {
  usernameInput:
    'input[name="user"], input[id*="user" i], input[name="usuario"], input[type="text"]:first-of-type',
  passwordInput:
    'input[name="pass"], input[name="password"], input[type="password"]:first-of-type',
  submitButton:
    'button[type="submit"], input[type="submit"], a[id*="ingresar" i]',
  errorMessage:
    '.error, .ErrorMessage, [class*="error" i]:not(script), [id*="error" i]:not(script)',
  captchaIndicator:
    '.g-recaptcha, [class*="captcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
  loggedInIndicator:
    '.usuario-logueado, [class*="menuUsuario" i], [id*="usuarioLogueado" i], [id*="bienvenido" i]',
};

const BPS_TASK_URLS: Record<PortalTask, string> = {
  consulta_estado_cuenta:
    "https://www.bps.gub.uy/bps/servlet/consultaEstadoCuenta",
  descarga_constancia:
    "https://www.bps.gub.uy/bps/servlet/constanciaVigencia",
  consulta_deuda:
    "https://www.bps.gub.uy/bps/servlet/consultaDeuda",
};

// Max raw text extracted per task response
const MAX_EXTRACTED_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PortalBrowserService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private browserBinding: any) {}

  /**
   * Logs in to the specified portal using the provided credentials.
   * On success returns the session cookies ready to be encrypted and stored.
   */
  async login(
    portal: Portal,
    username: string,
    password: string
  ): Promise<LoginResult> {
    const browser = await puppeteer.launch(this.browserBinding);
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(30_000);

      const loginUrl  = portal === "dgi" ? DGI_LOGIN_URL  : BPS_LOGIN_URL;
      const selectors = portal === "dgi" ? DGI_SELECTORS  : BPS_SELECTORS;

      await page.goto(loginUrl, { waitUntil: "networkidle2" });

      // Detect CAPTCHA before attempting login — bail out early if present
      const hasCaptcha = await page
        .$(selectors.captchaIndicator)
        .then((el) => el !== null)
        .catch(() => false);
      if (hasCaptcha) {
        return {
          success: false,
          error:
            "El portal requiere resolver un CAPTCHA. La automatización no está disponible en este momento.",
        };
      }

      // Locate the login form elements
      const usernameEl = await page.$(selectors.usernameInput);
      const passwordEl = await page.$(selectors.passwordInput);
      const submitEl   = await page.$(selectors.submitButton);

      if (!usernameEl || !passwordEl || !submitEl) {
        return {
          success: false,
          error:
            "No se encontró el formulario de login. Es posible que la estructura del portal haya cambiado.",
        };
      }

      await usernameEl.type(username, { delay: 20 });
      await passwordEl.type(password, { delay: 20 });
      await submitEl.click();

      // Wait for post-login state — either a success indicator or an error
      await Promise.race([
        page.waitForSelector(selectors.loggedInIndicator, { timeout: 15_000 }),
        page.waitForSelector(selectors.errorMessage, { timeout: 15_000 }),
      ]).catch(() => {
        /* neither appeared within the timeout — we'll check both below */
      });

      // Check for error message returned by the portal
      const errorEl = await page.$(selectors.errorMessage);
      if (errorEl) {
        const errorText: string = await page
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .evaluate((el: any) => (el.textContent ?? "").trim(), errorEl)
          .catch(() => "");
        return {
          success: false,
          error: errorText || "Credenciales inválidas o error en el portal.",
        };
      }

      // Confirm successful login indicator is present
      const loggedIn = await page.$(selectors.loggedInIndicator);
      if (!loggedIn) {
        return {
          success: false,
          error:
            "No se pudo confirmar el inicio de sesión. Verificá las credenciales y que el portal esté disponible.",
        };
      }

      // Extract session cookies
      const rawCookies = await page.cookies();
      const cookies: PortalCookie[] = rawCookies.map((c) => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain,
        path:     c.path,
        expires:  c.expires,
        httpOnly: c.httpOnly,
        secure:   c.secure,
        sameSite: c.sameSite as string | undefined,
      }));

      return { success: true, cookies };
    } finally {
      await browser.close();
    }
  }

  /**
   * Restores a session from stored cookies and executes the requested task.
   * Returns `{ success: false, error: 'La sesión expiró...' }` when cookies
   * are no longer valid, signalling the caller to trigger a re-login.
   */
  async runTask(
    portal: Portal,
    cookies: PortalCookie[],
    task: PortalTask,
    params?: Record<string, string>
  ): Promise<TaskResult> {
    void params; // reserved for future task-specific parameters

    const browser = await puppeteer.launch(this.browserBinding);
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(30_000);

      const loginUrl  = portal === "dgi" ? DGI_LOGIN_URL  : BPS_LOGIN_URL;
      const selectors = portal === "dgi" ? DGI_SELECTORS  : BPS_SELECTORS;

      // Restore session by setting stored cookies before navigating
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.setCookie(...(cookies as any[]));
      await page.goto(loginUrl, { waitUntil: "networkidle2" });

      // Verify the session is still active
      const stillLoggedIn = await page.$(selectors.loggedInIndicator);
      if (!stillLoggedIn) {
        return {
          success: false,
          error:
            "La sesión del portal expiró. Reconectá el portal con tus credenciales.",
        };
      }

      // Navigate to the task-specific URL and extract page text
      const taskUrls = portal === "dgi" ? DGI_TASK_URLS : BPS_TASK_URLS;
      await page.goto(taskUrls[task], { waitUntil: "networkidle2" });

      const rawText = (await page
        .evaluate("(document.body.innerText || document.body.textContent || '').trim()")
        .catch(() => "")) as string;

      return {
        success: true,
        data: { raw_text: rawText.slice(0, MAX_EXTRACTED_CHARS) },
      };
    } finally {
      await browser.close();
    }
  }
}
