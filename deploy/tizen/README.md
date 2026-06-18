# Tizen Deployment (Samsung TV)

This folder is a packaging target for Samsung Tizen TV.
The runtime app logic remains the shared PWA in ../../public.

## Prepare local package assets

1. Run:

```bash
node deploy/tizen/prepare-tizen-package.mjs
```

2. This copies the shared PWA into:

- deploy/tizen/public

3. Package/sign with your Tizen CLI profile to produce a .wgt.

## Notes

- Keep Tizen-only files inside deploy/tizen.
- Do not fork app logic for Tizen.
- Tizen MVP reports download/offline as unsupported in capability negotiation.
