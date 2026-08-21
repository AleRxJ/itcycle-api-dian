# Anexos técnicos y fuentes oficiales DIAN

Referencias externas para monitorear cambios en el Sistema de Facturación Electrónica (SFE) que
puedan afectar a `dian-kit` o a ITCycle. No depender solo de GitHub para enterarse de cambios.

## Fuentes oficiales

- Documentación técnica DIAN (anexos, XSD, catálogo de errores):
  https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/documentacion-tecnica/
- Portal de habilitación / catálogo Sandbox: https://catalogo-vpfe-hab.dian.gov.co/
- Política de firma electrónica (XAdES-EPES), v2:
  https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf

## Referencia interna (dentro de `dian-kit`, no modificar)

- [`dian-kit/docs/technical-reference/dian-xml-specifications.md`](../../dian-kit/docs/technical-reference/dian-xml-specifications.md)
- [`dian-kit/docs/errores-dian.md`](../../dian-kit/docs/errores-dian.md) — catálogo de errores DIAN comunes y solución
- [`dian-kit/docs/guia-certificado.md`](../../dian-kit/docs/guia-certificado.md) — cómo obtener un certificado .p12

## Endpoints SOAP (`@dian-kit/core`)

| Ambiente | Servicio | WSDL |
|---|---|---|
| Producción | `https://vpfe.dian.gov.co/WcfDianCustomerServices.svc` | `?wsdl` |
| Sandbox (Habilitación) | `https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc` | `?wsdl` |

## Proceso de actualización

Cuando la DIAN publique cambios en anexos técnicos, catálogos o validaciones:

1. Revisar el changelog/commits de `sergioarojasm98/dian-kit` en GitHub.
2. Revisar comunicados oficiales de la DIAN (enlaces arriba).
3. Comparar contra la versión pinneada en [`compatibility.md`](./compatibility.md).
4. Si aplica una actualización del submódulo: correr `pnpm test` dentro de `dian-kit/`, correr
   pruebas de Sandbox, revisar compatibilidad con `src/` de ITCycle, e incorporar deliberadamente
   (nunca actualización automática). Ver [`changelog.md`](./changelog.md) para el registro de
   cada incorporación.
