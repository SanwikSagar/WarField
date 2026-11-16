/**
 * Device / tier facts shared by every system (set once at boot by Game, updated by Renderer when
 * the quality preset changes). Plain mutable object: read it, never cache derived decisions forever.
 */
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
const small = typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < 820;

export const Platform = {
    /** phone / tablet: touch-first input, mobile render budget */
    mobile: /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || (coarse && touch && small) || (touch && /Macintosh/.test(ua) && small),
    touch: touch || coarse,
    /** 'low' | 'medium' | 'high' | 'ultra' | 'extreme' (Renderer keeps it current) */
    tier: 'high',
    get rich() { return !this.mobile && (this.tier === 'high' || this.tier === 'ultra' || this.tier === 'extreme'); }
};
if (typeof window !== 'undefined') {
    const q = new URLSearchParams(location.search);
    if (q.has('mobile')) Platform.mobile = Platform.touch = q.get('mobile') !== '0';     // ?mobile=1 to test on desktop
}
