	.text
	.globl _start
_start:
	setwd wsz = 0x10, nfx = 0x0
	setbn rbs = 0x0, rsz = 0x7, rcur = 0x0
	movts,0 0x0, %b[12]
	movts,0 0x1, %b[13]
	movts,0 0x8, %b[14]
	movts,0 0x11, %b[15]
	# --- write(1, NULL, 0): холостой системный вызов, ровно та же форма, что у сайта печати ---
	movts,0 0x4, %r8
	movts,0 0x1, %r9
	movts,0 0x0, %r10
	movts,0 0x0, %r11
	setwd wsz = 0x8, nfx = 0x0
	sdisp %ctpr1, 0x3
	ipd 3
	call %ctpr1, wbs = 0x4
	setwd wsz = 0x10, nfx = 0x0
	# --- exit(%b[15]): что уцелело в блоке рантайма после системного вызова ---
	movts,0 0x0, %b[11]
	movts,0 0x1, %r8
	adds,0 %b[15], %b[11], %r9
	setwd wsz = 0x8, nfx = 0x0
	sdisp %ctpr1, 0x3
	ipd 3
	call %ctpr1, wbs = 0x4
	nop
