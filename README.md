# CLS Notes — Offline-First E2EE (esqueleto)

Proyecto demo con la estructura inicial para la app de notas offline-first y E2EE.

Principales archivos añadidos:
- [package.json](package.json)
- [src/core/crypto.ts](src/core/crypto.ts)
- [src/core/db.ts](src/core/db.ts)
- [src/core/p2p.ts](src/core/p2p.ts)
- [src/core/export.ts](src/core/export.ts)
- [src/components/NotesView.tsx](src/components/NotesView.tsx)

Pasos para ejecutar:

1. Instalar dependencias:
```bash
npm install
```

2. Levantar en desarrollo:
```bash
npm run dev
```

Notas:
- La implementación actual es un scaffold funcional con cifrado en cliente (PBKDF2 + AES-GCM) y almacenamiento en IndexedDB (Dexie).
- Faltan mejoras: streaming export/import, UI de sincronización WebRTC/QR, manejo avanzado de imágenes y backups chunked.

Despliegue en GitHub Pages:

1. En GitHub, activa Pages usando la fuente "GitHub Actions".
2. El workflow vive en [.github/workflows/deploy.yml](.github/workflows/deploy.yml) y publica automáticamente en `main`.
3. La app se construye con `VITE_BASE_PATH=/cls/`, que es el prefijo correcto para un project page llamado `cls`.

Si cambias el nombre del repositorio, actualiza `VITE_BASE_PATH` en el workflow y la propiedad `base` de [vite.config.ts](vite.config.ts).
