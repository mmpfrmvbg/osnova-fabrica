#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Независимый эталон для пяти DSP-ядер (FIR, IIR, БПФ, свёртка, корреляция).

Написан отдельно от программ на Основе: те же определения, другая реализация, другой
язык. Совпадение значений — основание считать, что ядро считает то, что задумано.

Запуск:  python tests/dsp/reference.py            # печатает JSON
         python tests/dsp/reference.py --write    # пишет tests/dsp/reference.json

ВАЖНО: этот файл НЕ вызывается из тестов (в песочнице это ненадёжно). Тест читает
`reference.json` — артефакт, созданный этим файлом, и сверяет с ним прогон на VM.
"""

import json
import os
import sys

# --- 1. FIR: y[n] = sum_k h[k] * x[n-k], n от len(h)-1 до len(x)-1 ---

def fir(x, h):
    out = []
    for n in range(len(h) - 1, len(x)):
        total = 0
        for k in range(len(h)):
            total += h[k] * x[n - k]
        out.append(total)
    return out


# --- 2. IIR первого порядка: y[n] = (3*x[n] + 2*y[n-1]) / 5, целочисленно ---

def iir(x):
    out = []
    prev = 0
    for value in x:
        cur = (3 * value + 2 * prev) // 5
        out.append(cur)
        prev = cur
    return out


# --- 3. БПФ radix-2, N = 4: W = -i, поворотные множители целые ---

def fft4(x):
    x0, x1, x2, x3 = x[0], x[1], x[2], x[3]
    s02, d02 = x0 + x2, x0 - x2
    s13, d13 = x1 + x3, x1 - x3
    # (Re, Im) по каждому выходу; записывается поочерёдно, как в ядре
    out = [
        s02 + s13, 0,          # X0
        d02, -d13,             # X1
        s02 - s13, 0,          # X2
        d02, d13,              # X3
    ]
    return out


# --- 4. Полная свёртка ---

def convolution(a, b):
    out = []
    for n in range(len(a) + len(b) - 1):
        total = 0
        for k in range(len(a)):
            j = n - k
            if 0 <= j < len(b):
                total += a[k] * b[j]
        out.append(total)
    return out


# --- 5. Взаимная корреляция ---

def correlation(a, b):
    out = []
    for lag in range(len(b) - len(a) + 1):
        total = 0
        for i in range(len(a)):
            total += a[i] * b[i + lag]
        out.append(total)
    return out


def checksums():
    x_fir = [3, 1, 4, 1, 5, 9, 2, 6]
    h_fir = [1, 2, 3, 4]
    x_iir = [10, 20, 30, 40, 50]
    x_fft = [1, 2, 3, 4]
    a = [1, 2, 3]
    b = [4, 5, 6]

    return {
        "fir": {"input": x_fir, "coefficients": h_fir, "output": fir(x_fir, h_fir),
                "checksum": sum(fir(x_fir, h_fir))},
        "iir": {"input": x_iir, "output": iir(x_iir), "checksum": sum(iir(x_iir))},
        "fft": {"input": x_fft, "output": fft4(x_fft), "checksum": sum(fft4(x_fft))},
        "convolution": {"a": a, "b": b, "output": convolution(a, b),
                        "checksum": sum(convolution(a, b))},
        "correlation": {"a": a, "b": b, "output": correlation(a, b),
                        "checksum": sum(correlation(a, b))},
    }


def main():
    data = checksums()
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    if "--write" in sys.argv:
        target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference.json")
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text + "\n")
        print("записано: %s" % target)
    else:
        print(text)


if __name__ == "__main__":
    main()
