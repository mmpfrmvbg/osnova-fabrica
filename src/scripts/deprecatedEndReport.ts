#!/usr/bin/env node
/** Точка входа отчёта: логика — в `./deprecatedEnds`. */

import { reportDeprecatedEnds } from "./deprecatedEnds";

process.exit(
  reportDeprecatedEnds({
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }),
);
