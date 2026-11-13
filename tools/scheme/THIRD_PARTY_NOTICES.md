# Сторонние компоненты

- **three.js** — MIT, https://github.com/mrdoob/three.js
- **occt-import-js 0.0.23** — LGPL-2.1, https://github.com/kovacsv/occt-import-js
  - Исходный commit npm-релиза: `c2148e54b456b571238d35cac037d304053d64b2`.
  - Соответствующие исходники (включая указатель на OpenCascade submodule): https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2
  - Текст лицензии: https://github.com/kovacsv/occt-import-js/blob/c2148e54b456b571238d35cac037d304053d64b2/LICENSE.md
  - Библиотека JS/WASM не модифицирована. Можно заменить npm-зависимость и пересобрать приложение. Наша подготовка STEP выполняется отдельным модулем, не патчем бинарника.
  - OpenCascade: LGPL-2.1 с дополнительным исключением OCCT; https://dev.opencascade.org/resources/licensing
- **three-gpu-pathtracer 0.0.28** — MIT, https://github.com/gkjohnson/three-gpu-pathtracer — трассировка лучей режима «Модель», загружается по кнопке отдельным модулем.
- **three-mesh-bvh 0.9.18** — MIT, https://github.com/gkjohnson/three-mesh-bvh — BVH для трассировки (в отдельном worker).
- **Vite**, **Playwright** и **TypeScript** используются для сборки/проверок; лицензии сохранены в установленных npm-пакетах.

Перед распространением production-сборки сохраните тексты лицензий/уведомления и обеспечьте доступ к соответствующим исходникам LGPL-компонентов и возможности их замены согласно условиям лицензий.
