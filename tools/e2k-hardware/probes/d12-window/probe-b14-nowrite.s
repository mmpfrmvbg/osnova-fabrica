	.text
	.globl _start
_start:
	setwd wsz = 0x10, nfx = 0x0
	setbn rbs = 0x0, rsz = 0x7, rcur = 0x0
	movts,0 0x0, %b[12]
	movts,0 0x1, %b[13]
	movts,0 0x8, %b[14]
	movts,0 0x11, %b[15]
	# --- exit(%b[14]): что уцелело в блоке рантайма после системного вызова ---
	movts,0 0x0, %b[11]
	movts,0 0x1, %r8
	adds,0 %b[14], %b[11], %r9
	setwd wsz = 0x8, nfx = 0x0
	sdisp %ctpr1, 0x3
	ipd 3
	call %ctpr1, wbs = 0x4
	nop
