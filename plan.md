# Plan de Desarrollo: App de Notas Offline-First E2EE (End-to-End Encrypted)

## 🎯 Objetivo del Proyecto
Desarrollar una aplicación de toma de notas "offline-first" enfocada en la privacidad extrema. La aplicación será una Single Page Application (SPA) estática donde **ningún dato** tocará jamás un servidor en la nube de forma persistente. Todo se guarda localmente, se cifra en el cliente y las transferencias de sincronización son peer-to-peer (P2P) o mediante archivos locales.

## 🛠️ Stack Tecnológico
* **Core:** React + TypeScript + Vite.
* **Estilos:** TailwindCSS.
* **Base de Datos Local:** IndexedDB (utilizando `Dexie.js` para manejo de promesas y tipado).
* **Criptografía:** Web Crypto API nativa (Cero dependencias externas).
* **Sincronización:** WebRTC para P2P (Señalización vía Códigos QR con compresión de SDP).
* **Deployment:** GitHub Actions desplegando en GitHub Pages (Página 100% estática).

---

## 🛑 Requisitos Arquitectónicos Estrictos (Reglas de Oro)

1.  **Cifrado Absoluto (Zero-Knowledge):**
    * Al iniciar, la app pedirá una contraseña maestra.
    * Derivar clave usando `PBKDF2` (Web Crypto API).
    * Todos los datos (texto e imágenes) deben cifrarse con `AES-GCM` antes de tocar IndexedDB.
    * **Prohibido:** Guardar contraseñas o claves maestras descifradas en `localStorage` o `sessionStorage`. La clave vive solo en memoria (RAM) mientras la app está abierta.

2.  **Manejo Eficiente de Imágenes (Cero Base64 en BD):**
    * **Prohibido:** Guardar imágenes en Base64 en la base de datos (causa sobrecarga de memoria).
    * **Flujo de guardado:** `File/Blob` -> `ArrayBuffer` -> `Cifrado AES-GCM` -> Guardar binario cifrado en IndexedDB.
    * **Flujo de lectura:** Leer binario de IndexedDB -> `Descifrado AES-GCM` -> `Blob` -> Mostrar en UI con `URL.createObjectURL()`.
    * Para optimizar el rendimiento, se usarán tablas separadas en IndexedDB: una para `notas` y otra para `imagenes`. Las notas solo guardarán el `ID` de la imagen referenciada.

3.  **Sincronización P2P sin Servidor (WebRTC + QR):**
    * Se implementará WebRTC usando Data Channels para la sincronización unidireccional (emisor -> receptor).
    * La señalización se hará escaneando un código QR. Dado que las ofertas/respuestas SDP son largas, se debe usar un algoritmo de compresión (como `fflate` o `lz-string`) para achicar el payload antes de generar el QR.
    * Sincronización Inteligente: Solo se enviarán "deltas" (registros creados o modificados desde la última sincronización basada en un timestamp local).

4.  **Exportación de Seguridad (Backup Total):**
    * Debe existir la capacidad de exportar toda la base de datos a un solo archivo físico cifrado, sin importar su tamaño (usar Streams o chunks si es necesario para evitar colapso de memoria).

5.  **Monitoreo de Cuota:**
    * Usar `navigator.storage.estimate()` para mostrar en todo momento al usuario cuánto espacio de la cuota del navegador está en uso y cuánto queda disponible.

---

## 📂 Arquitectura de Directorios Sugerida

```text
/src
 ├── /assets           
 ├── /components       # UI Components (Editor, Modales de QR, Indicador de Cuota)
 ├── /core             # Lógica de negocio (Independiente de React)
 │    ├── crypto.ts    # Encriptación/Desencriptación nativa
 │    ├── db.ts        # Configuración y esquemas de Dexie.js
 │    ├── p2p.ts       # Lógica WebRTC y compresión SDP para QR
 │    └── export.ts    # Lógica de Backup (Generación de archivo binario/JSON)
 ├── /hooks            # Hooks (e.g., useStorageQuota, useSync, useNotes)
 ├── App.tsx           # Router y vista de Login/Desbloqueo
 └── main.tsx
```

---

## Extras

- Se debe poder copiar y pegar imagenes o subirlas con un boton de subir imagen en las notas
- Las notas deben basarse en un sistema de texto enriquecido, en md en concreto