# Licence and attribution

The contents of `spec/` are licensed under the
[Creative Commons Attribution-ShareAlike 4.0 International](LICENSE)
licence (CC BY-SA 4.0).

## Adapted material

Parts of this specification are adapted from:

> Мурад Нейман-заде, Сергей Королёв. *Руководство по эффективному
> программированию на платформе «Эльбрус»*, версия 1.1. © 2021 АО «МЦСТ».
> Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
> Mirror: http://ataraxia.fwgs.gay/repo/pub/docs/elbrus_prog/html

The material was translated, restructured, condensed and combined with facts
from other sources; see the "Sources" sections of the individual documents
for which parts come from the guide. MCST does not endorse this
specification.

## Other sources

Facts about encodings, register numbers and system interfaces were obtained
from MCST's GPL/LGPL sources (binutils, gdb, glibc, Linux, the E2K GCC runtime
libraries) and from QEMU. The machine-readable files (`*.yaml`) are generated
from those sources by the tools in `tools/`, and each records the source
revision it was generated from.

Some behaviour was observed in the output of MCST's lcc and Unipro's LLVM
compilers, used as black boxes. No code from them is included.
