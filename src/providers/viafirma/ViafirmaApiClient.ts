import { createHmac } from "node:crypto";

import OAuth from "oauth-1.0a";

import { CertificateProviderTechnicalError } from "../certificates/CertificateProviderRegistry.js";
import type {
  ViafirmaAvailableProfile,
  ViafirmaCreateRequestParams,
  ViafirmaCreateRequestResult,
  ViafirmaFileUpload,
  ViafirmaProfileFormField,
  ViafirmaProviderConfig,
  ViafirmaRevocationCodeResult,
  ViafirmaUploadedFile,
} from "../certificates/ViafirmaCertificateProvider.js";

/**
 * Thin wrapper over Viafirma Colombia's RA API for PKCS#10 profiles
 * ("Uso del API para perfiles PKCS#10 v1.7", verified against the
 * accompanying Postman collection). Mirrors the shape of
 * `../firmapass/FirmaPassClient.ts` (single private `request<T>`, one
 * method per documented endpoint) but signs every call with OAuth 1.0
 * (HMAC-SHA1, 2-legged — no oauth_token, matching the Postman collection's
 * own auth config: addParamsToHeader=true, addEmptyParamsToSign=false, no
 * token). Only query-string/form parameters are part of the OAuth1
 * signature per spec — the JSON request bodies used by
 * `createRequestFromCsr`/`uploadFile` are NOT signed, matching how
 * Postman's own oauth1 helper behaves for this collection (no body-hash
 * option configured there either).
 */
export class ViafirmaApiClient {
  private readonly oauth: OAuth;

  constructor(private readonly config: ViafirmaProviderConfig) {
    this.oauth = new OAuth({
      consumer: { key: config.consumerKey, secret: config.consumerSecret },
      signature_method: "HMAC-SHA1",
      hash_function: (baseString, key) => createHmac("sha1", key).update(baseString).digest("base64"),
    });
  }

  private authHeader(url: string, method: string): { Authorization: string } {
    return this.oauth.toHeader(this.oauth.authorize({ url, method }));
  }

  private async request<T>(path: string, init: RequestInit & { baseUrl?: string } = {}): Promise<T> {
    const baseUrl = init.baseUrl ?? this.config.baseUrl;
    const url = `${baseUrl}${path}`;
    const method = init.method ?? "GET";

    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.authHeader(url, method),
        ...init.headers,
      },
    });

    const rawBody = await response.text();

    if (!response.ok) {
      let cleanMessage: string | undefined;
      try {
        const parsed = JSON.parse(rawBody);
        cleanMessage =
          typeof parsed?.errorDescription === "string"
            ? parsed.errorDescription
            : typeof parsed?.message === "string"
              ? parsed.message
              : undefined;
      } catch {
        // Non-JSON body - no clean message to extract.
      }
      // A CertificateProviderTechnicalError (not a bare Error) so
      // CertificateProviderRegistry's fallback rule can key off it (see that
      // class's own doc comment) - a bare Error was silently invisible to
      // fallbackForNewRequestFailure. `.message` is always short and safe to
      // show a user; the raw body (which can be an entire HTML page from a
      // Sandbox quirk - see below) goes on `.cause` instead, never inline.
      throw new CertificateProviderTechnicalError(
        cleanMessage || `Viafirma request failed (status ${response.status}). Please try again shortly.`,
        "viafirma",
        { status: response.status, path, rawBody: rawBody.slice(0, 2000) },
      );
    }

    try {
      return JSON.parse(rawBody) as T;
    } catch {
      // A 2xx status with a non-JSON body — seen from Viafirma Sandbox on
      // some paths (e.g. an entire HTML page, sometimes even a pre-filled
      // "nueva solicitud" web form) instead of the documented JSON. This
      // used to embed that raw HTML directly in the thrown Error's own
      // `.message`, which is what a caller shows verbatim to an end user -
      // see this file's own history for the actual incident. Same fix as
      // the branch above: clean message on `.message`, full detail on
      // `.cause` only.
      throw new CertificateProviderTechnicalError(
        "Viafirma returned an unexpected response. Please try again shortly, or contact support if this persists.",
        "viafirma",
        { status: response.status, path, rawBody: rawBody.slice(0, 2000) },
      );
    }
  }

  /** GET /ra/available-profiles?codRa={ra} — §2.3.1. */
  async getAvailableProfiles(ra: string): Promise<ViafirmaAvailableProfile[]> {
    const result = await this.request<{ items: ViafirmaAvailableProfile[] }>(
      `/ra/available-profiles?codRa=${encodeURIComponent(ra)}`,
    );
    return result.items;
  }

  /** GET /ra/profile/{codProfile}/form?required=true — §3.3. */
  async getProfileForm(codProfile: string): Promise<ViafirmaProfileFormField[]> {
    const result = await this.request<{ items: ViafirmaProfileFormField[] }>(
      `/ra/profile/${encodeURIComponent(codProfile)}/form?required=true`,
    );
    return result.items;
  }

  /** POST /request/fromCSR — §2.3.2. */
  async createRequestFromCsr(payload: ViafirmaCreateRequestParams): Promise<ViafirmaCreateRequestResult> {
    const { profileKind, ...body } = payload;
    void profileKind; // discriminant only, not part of the wire payload
    const organizationType = "organizationType" in payload ? payload.organizationType : "";
    return this.request<ViafirmaCreateRequestResult>("/request/fromCSR", {
      method: "POST",
      body: JSON.stringify({ ...body, organizationType }),
    });
  }

  /** GET /request/{codRequest}/status — §2.3.4. */
  async getRequestStatus(codRequest: string): Promise<string> {
    const result = await this.request<{ code: string }>(`/request/${encodeURIComponent(codRequest)}/status`);
    return result.code;
  }

  /** GET /services/accreditation/{codRequest} — §2.3.8. */
  async getKycLink(codRequest: string): Promise<string> {
    const result = await this.request<{ link: string }>(`/services/accreditation/${encodeURIComponent(codRequest)}`);
    return result.link;
  }

  /** POST /files/upload/ — §2.3.7. */
  async uploadFile(codRequest: string, file: ViafirmaFileUpload): Promise<ViafirmaUploadedFile[]> {
    return this.request<ViafirmaUploadedFile[]>("/files/upload/", {
      method: "POST",
      body: JSON.stringify({ codeRequest: codRequest, files: [file] }),
    });
  }

  /** GET /files/list/{codRequest} — §2.3.7. */
  async listUploadedFiles(codRequest: string): Promise<ViafirmaUploadedFile[]> {
    return this.request<ViafirmaUploadedFile[]>(`/files/list/${encodeURIComponent(codRequest)}`);
  }

  /**
   * GET {urlRADescarga}/downloadCertificateServlet?req={publicId} — §2.3.5.
   * Uses `config.downloadBaseUrl`, NOT `config.baseUrl` — a separate host
   * per the Postman collection's `{{urlRADescarga}}` variable (see
   * REQUIERE_CONFIRMACION_VIAFIRMA note on ViafirmaProviderConfig.downloadBaseUrl).
   * Response body is the raw P7B bytes, not JSON — returned as a Buffer.
   */
  async downloadP7b(publicId: string): Promise<Buffer> {
    const url = `${this.config.downloadBaseUrl}/downloadCertificateServlet?req=${encodeURIComponent(publicId)}`;
    const response = await fetch(url, { headers: this.authHeader(url, "GET") });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CertificateProviderTechnicalError(
        `Failed to download the certificate from Viafirma (status ${response.status}). Please try again shortly.`,
        "viafirma",
        { status: response.status, url, body: body.slice(0, 2000) },
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** GET /request/{codRequest}/revocationCode — §2.3.6. */
  async getRevocationCode(codRequest: string): Promise<ViafirmaRevocationCodeResult> {
    return this.request<ViafirmaRevocationCodeResult>(`/request/${encodeURIComponent(codRequest)}/revocationCode`);
  }

  /** POST /request/revoke/code/{revokingCode} — §2.3.6 (Postman collection). */
  async revokeByCode(revokingCode: string, revocationReason = 0): Promise<{ code: string }> {
    return this.request<{ code: string }>(`/request/revoke/code/${encodeURIComponent(revokingCode)}`, {
      method: "POST",
      body: JSON.stringify({ revocationReason }),
    });
  }
}
