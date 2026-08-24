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
 * Thin wrapper over the FirmaPass identity-validation/certificate-issuance
 * API (identidad.firmapass.com) — field/endpoint shapes verified against the
 * provider's own Postman collection, not paraphrased docs. Auth is a
 * per-company Bearer login key (see Company.firmaPassLoginKeyCiphertext),
 * passed explicitly to every call rather than read from a global env var.
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

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.loginKey}`,
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`FirmaPass request failed (${response.status} ${path}): ${body}`);
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
}
