const DEFAULT_BASE_URL = "https://identidad.firmapass.com";

export interface FirmaPassRutResponse {
  message: string;
  data: {
    uuid: string;
    estado: string;
    estado_descripcion: string;
    pending_documents: string[];
    uploaded_documents: string[];
  };
}

export interface FirmaPassArchivoResponse {
  message: string;
  file: { type: string; uploaded_at: string };
  uploaded_documents: string[];
  pending_documents: string[];
}

export interface FirmaPassConfirmarResponse {
  message: string;
  certificate: {
    uuid: string;
    identificador: string;
    estado: string;
    estado_descripcion: string;
  };
  /**
   * Only non-null for non-centralized signatures, and only ever returned
   * here — FirmaPass never stores or re-serves it. Must be captured and
   * moved into a CertificateSecretStore immediately by the caller; never
   * logged.
   */
  private_key_pem: string | null;
}

export interface FirmaPassCertificateDetail {
  uuid: string;
  identificador: string;
  estado: string; // "pe" en espera, "v" vigente, "e" expirado, "r" revocado, "d" ...
  estado_descripcion: string;
  sign_alg: string | null;
  serial_number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_centralized_signature: boolean;
  validacion: { uuid: string; nombre: string } | null;
  /** Non-null only once estado === "v". */
  public_certificate_pem: string | null;
}

export interface FirmaPassGetCertificateResponse {
  message: string;
  data: FirmaPassCertificateDetail;
}

/**
 * Verified against FirmaPass's own Postman collection (not paraphrased).
 * `owner_email` (the FirmaPass account's email) and `order_number` (set once
 * a real purchase, as opposed to this alliance's coupon-attached test/manual
 * validations, carries one) are both real identifying fields on top of
 * `nombre` - `order_number` is also a valid filter on GET
 * /api/validaciones-identidad (see FirmaPassClient.listValidations). `[key:
 * string]: unknown` stays as a safety net for anything not modeled here.
 */
export interface FirmaPassValidationSummary {
  uuid: string;
  nombre: string;
  owner_email: string | null;
  order_number: string | null;
  estado: string;
  estado_descripcion: string;
  categoria: string;
  categoria_descripcion: string;
  tipo: string;
  tipo_descripcion: string;
  categoria_tipo_descripcion: string;
  created_at: string;
  /**
   * Signed, temporary URL where the CLIENT can complete the validation
   * themselves on FirmaPass's own site (upload documents, etc.) - null once
   * the validation is past `p`/`pvi`. This is FirmaPass's simpler
   * recommended flow: handing the client this link needs no Ohnix-built
   * upload UI at all.
   */
  completion_url: string | null;
  pending_documents: unknown[] | null;
  uploaded_documents: unknown;
  [key: string]: unknown;
}

export interface FirmaPassListValidationsResponse {
  message?: string;
  data: FirmaPassValidationSummary[];
  meta?: Record<string, unknown>;
}

export interface FirmaPassValidationDetail extends FirmaPassValidationSummary {
  current_certificate?: FirmaPassCertificateDetail | null;
}

export interface FirmaPassGetValidationResponse {
  message?: string;
  data: FirmaPassValidationDetail;
}

/**
 * Thin wrapper over the FirmaPass identity-validation/certificate-issuance
 * API (identidad.firmapass.com) — field/endpoint shapes verified against the
 * provider's own Postman collection, not paraphrased docs. Auth is a Bearer
 * login key passed explicitly to every call rather than read from a global
 * env var here — but every caller in this codebase now passes iTCycle's own
 * shared "alianza" key (env.firmaPassAllianceLoginKey), never a per-company
 * one; see modules/firmapass/firmaPassIssuance.service.ts for why.
 *
 * Note the two write endpoints that matter most for issuance (archivos,
 * confirmar) do NOT use the {message, data} envelope the GET endpoints use —
 * this is deliberate, not an inconsistency to "fix".
 */
export class FirmaPassClient {
  constructor(
    private readonly loginKey: string,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  private async request<T>(path: string, init: RequestInit, options: { treat404AsNull?: boolean } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.loginKey}`,
        ...init.headers,
      },
    });

    if (response.status === 404 && options.treat404AsNull) {
      return null as T;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // FirmaPass's own error responses are clean JSON ({"message": "No fue
      // posible identificar la fecha de generación..."}) - the RUT/document
      // upload endpoints in particular return specific, actionable validation
      // messages that should reach the end user verbatim (Ohnix is standing
      // in for FirmaPass's own "Carga de Documentos de Identidad" step, so
      // these need to be exactly as consistent/helpful as FirmaPass's own
      // site). Only fall back to the generic wrapped form when the body isn't
      // parseable JSON with a message/error field.
      let cleanMessage: string | undefined;
      try {
        const parsed = JSON.parse(body);
        cleanMessage = typeof parsed?.message === "string" ? parsed.message : typeof parsed?.error === "string" ? parsed.error : undefined;
      } catch {
        // Non-JSON body - no clean message to extract.
      }
      throw new Error(cleanMessage || `FirmaPass request failed (${response.status} ${path}): ${body}`);
    }

    return (await response.json()) as T;
  }

  async uploadRut(
    validationUuid: string,
    params: { rutBase64: string; identificacionRepresentanteLegal?: string },
  ): Promise<FirmaPassRutResponse> {
    return this.request(`/api/validaciones-identidad/factura-electronica/${validationUuid}/rut`, {
      method: "POST",
      body: JSON.stringify({
        rut_base64: params.rutBase64,
        ...(params.identificacionRepresentanteLegal
          ? { identificacion_representante_legal: params.identificacionRepresentanteLegal }
          : {}),
      }),
    });
  }

  async uploadArchivo(
    validationUuid: string,
    params: { type: string; fileBase64: string },
  ): Promise<FirmaPassArchivoResponse> {
    return this.request(`/api/validaciones-identidad/factura-electronica/${validationUuid}/archivos`, {
      method: "POST",
      body: JSON.stringify({ type: params.type, file_base64: params.fileBase64 }),
    });
  }

  async confirmar(validationUuid: string): Promise<FirmaPassConfirmarResponse> {
    return this.request(`/api/validaciones-identidad/factura-electronica/${validationUuid}/confirmar`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async getCertificate(identificador: string): Promise<FirmaPassGetCertificateResponse> {
    return this.request(`/api/certificados/${identificador}`, { method: "GET" });
  }

  /**
   * Every validation visible to this login key, newest first. `perPage`
   * (integer 1-100, defaults to 20) and `orderNumber` are the two documented
   * query params — there is no documented `page` param despite `meta`
   * echoing back current_page/last_page. `orderNumber` does an exact match
   * against `order_number` (only set once a real order/purchase, not this
   * alliance's coupon-attached test validations, has one) - the reliable way
   * to look up a specific client's validation once the queue outgrows what
   * `perPage` alone can return in one page.
   */
  async listValidations(params: { perPage?: number; orderNumber?: string } = {}): Promise<FirmaPassListValidationsResponse> {
    const query = new URLSearchParams();
    if (params.perPage) query.set("per_page", String(params.perPage));
    if (params.orderNumber) query.set("order_number", params.orderNumber);
    const qs = query.toString();
    return this.request(`/api/validaciones-identidad${qs ? `?${qs}` : ""}`, { method: "GET" });
  }

  /**
   * Oldest validation (estado `p`/`pvi`) with no documents uploaded yet — a
   * simple FIFO "what's next". Returns null when none exists (FirmaPass
   * responds 404 for this — an expected, common state, not a failure).
   */
  async getNuevaSolicitud(): Promise<FirmaPassGetValidationResponse | null> {
    return this.request(`/api/validaciones-identidad/nueva-solicitud`, { method: "GET" }, { treat404AsNull: true });
  }

  async getValidationDetail(validationUuid: string): Promise<FirmaPassGetValidationResponse> {
    return this.request(`/api/validaciones-identidad/${validationUuid}`, { method: "GET" });
  }
}
