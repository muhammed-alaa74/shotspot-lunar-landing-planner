import { Directive, ElementRef, NgZone, OnDestroy, OnInit, inject } from '@angular/core';

/** Adds the class "in" when the element scrolls into view (scroll-reveal animation). */
@Directive({ selector: '[appReveal]' })
export class Reveal implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private io?: IntersectionObserver;
  private motion?: MediaQueryList;
  private animation?: Animation;
  private timer?: number;
  private entered = false;
  private reduced = false;
  private canAnimate = false;

  private readonly onFocus = () => this.reveal(true);
  private readonly onMotionChange = (event: MediaQueryListEvent) => {
    this.reduced = event.matches;
    if (this.reduced) this.revealNow();
  };

  ngOnInit() {
    const node = this.el.nativeElement;
    node.classList.add('reveal');
    node.addEventListener('focusin', this.onFocus);
    if (typeof window === 'undefined') { this.revealNow(); return; }
    if (typeof window.matchMedia === 'function') {
      this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.motion.matches;
      if (typeof this.motion.addEventListener === 'function') this.motion.addEventListener('change', this.onMotionChange);
      else this.motion.addListener(this.onMotionChange);
    }
    this.canAnimate = typeof node.animate === 'function' && typeof node.getAnimations === 'function';
    if (this.reduced || !this.canAnimate || typeof IntersectionObserver === 'undefined') { this.revealNow(); return; }
    this.zone.runOutsideAngular(() => {
      this.io = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.reveal();
      }, { rootMargin: '0px 0px -40px 0px', threshold: 0.08 });
      this.io.observe(node);
    });
  }

  private reveal(immediate = false) {
    if (immediate) { this.entered = true; this.revealNow(); return; }
    if (this.entered) return;
    this.entered = true;
    this.io?.disconnect();
    if (this.reduced || !this.canAnimate) { this.revealNow(); return; }
    const delay = this.transitionDelay();
    if (delay) this.timer = window.setTimeout(() => { this.timer = undefined; this.startAnimation(); }, delay);
    else this.startAnimation();
  }

  private startAnimation() {
    if (this.reduced) { this.revealNow(); return; }
    const node = this.el.nativeElement;
    node.classList.add('in');
    this.cancelRevealTransitions(node);
    const animation = node.animate(
      [{ opacity: 0, transform: 'translateY(20px)' }, { opacity: 1, transform: 'none' }],
      { duration: 780, easing: 'cubic-bezier(.22, .61, .36, 1)', fill: 'none' },
    );
    this.animation = animation;
    void animation.finished.then(() => {
      if (this.animation === animation) this.animation = undefined;
    }).catch(() => undefined);
  }

  private revealNow() {
    const node = this.el.nativeElement;
    this.entered = true;
    this.io?.disconnect();
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.animation?.cancel();
    this.animation = undefined;
    node.classList.add('in');
    this.cancelRevealTransitions(node);
  }

  private transitionDelay() {
    const value = getComputedStyle(this.el.nativeElement).transitionDelay.split(',')[0]?.trim() ?? '';
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return value.endsWith('ms') ? amount : amount * 1000;
  }

  private cancelRevealTransitions(node: HTMLElement) {
    if (typeof node.getAnimations !== 'function') return;
    node.getAnimations().forEach((animation) => {
      const property = (animation as Animation & { transitionProperty?: unknown }).transitionProperty;
      if (typeof property !== 'string') return;
      if (property.split(',').some((item) => item.trim() === 'opacity' || item.trim() === 'transform')) animation.cancel();
    });
  }

  ngOnDestroy() {
    this.io?.disconnect();
    this.el.nativeElement.removeEventListener('focusin', this.onFocus);
    if (this.motion) {
      if (typeof this.motion.removeEventListener === 'function') this.motion.removeEventListener('change', this.onMotionChange);
      else this.motion.removeListener(this.onMotionChange);
    }
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.animation?.cancel();
  }
}
