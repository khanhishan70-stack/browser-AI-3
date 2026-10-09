(function (root) {
  'use strict';

  var NAMED = {
    white: [255, 255, 255], snow: [255, 250, 250], ivory: [255, 255, 240],
    linen: [250, 240, 230], beige: [245, 245, 220], whitesmoke: [245, 245, 245],
    ghostwhite: [248, 248, 255], aliceblue: [240, 248, 255], azure: [240, 255, 255],
    lightgray: [211, 211, 211], lightgrey: [211, 211, 211], silver: [192, 192, 192],
    gainsboro: [220, 220, 220], whitesmoke2: [245, 245, 245], gray: [128, 128, 128],
    grey: [128, 128, 128], dimgray: [105, 105, 105], darkgray: [169, 169, 169],
    black: [0, 0, 0], navy: [0, 0, 128], midnightblue: [25, 25, 112],
    darkslategray: [47, 79, 79], dimgrey: [105, 105, 105], slategray: [112, 128, 144],
    lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], gray11: [17, 17, 17],
    whitesmoke3: [245, 245, 245], wheat: [245, 222, 179], seashell: [255, 245, 238],
    oldlace: [253, 245, 230], floralwhite: [255, 250, 240], mintcream: [245, 255, 250],
    aquamarine: [127, 255, 212], turquoise: [64, 224, 208], lightcyan: [224, 255, 255],
    cyan: [0, 255, 255], teal: [0, 128, 128], steelblue: [70, 130, 180],
    royalblue: [65, 105, 225], dodgerblue: [30, 144, 255], deepskyblue: [0, 191, 255],
    skyblue: [135, 206, 235], lightblue: [173, 216, 230], cornflowerblue: [100, 149, 237],
    blue: [0, 0, 255], mediumblue: [0, 0, 205], darkblue: [0, 0, 139],
    indigo: [75, 0, 130], darkorchid: [153, 50, 204], purple: [128, 0, 128],
    darkmagenta: [139, 0, 139], fuchsia: [255, 0, 255], magenta: [255, 0, 255],
    violet: [238, 130, 238], plum: [221, 160, 221], orchid: [218, 112, 214],
    pink: [255, 192, 203], hotpink: [255, 105, 180], deeppink: [255, 20, 147],
    crimson: [220, 20, 60], red: [255, 0, 0], firebrick: [178, 34, 34],
    darkred: [139, 0, 0], orange: [255, 165, 0], darkorange: [255, 140, 0],
    coral: [255, 127, 80], tomato: [255, 99, 71], orangered: [255, 69, 0],
    gold: [255, 215, 0], yellow: [255, 255, 0], lightyellow: [255, 255, 224],
    lemonchiffon: [255, 250, 205], khaki: [240, 230, 140], darkkhaki: [189, 183, 107],
    olive: [128, 128, 0], olivedrab: [107, 142, 35], yellowgreen: [154, 205, 50],
    green: [0, 128, 0], darkgreen: [0, 100, 0], forestgreen: [34, 139, 34],
    seagreen: [46, 139, 87], lime: [0, 255, 0], limegreen: [50, 205, 50],
    lawngreen: [124, 252, 0], chartreuse: [127, 255, 0], springgreen: [0, 255, 127],
    mediumspringgreen: [0, 250, 154], darkgreen2: [0, 100, 0], brown: [165, 42, 42],
    saddlebrown: [139, 69, 19], sienna: [160, 82, 45], peru: [205, 133, 63],
    tan: [210, 180, 140], chocolate: [210, 105, 30], sandybrown: [244, 164, 96],
    rosybrown: [188, 143, 143], lightcoral: [240, 128, 128], salmon: [250, 128, 114],
    lightseagreen: [32, 178, 170], mediumaquamarine: [102, 205, 170], darkcyan: [0, 139, 139],
    palegreen: [152, 251, 152], paleturquoise: [175, 238, 238], aqua: [0, 255, 255],
    darkviolet: [148, 0, 211], mediumpurple: [147, 112, 219], slateblue: [106, 90, 205],
    rebeccapurple: [102, 51, 153]
  };

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function parse(input) {
    if (!input) return null;
    var s = String(input).trim().toLowerCase();

    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED[s]) return { r: NAMED[s][0], g: NAMED[s][1], b: NAMED[s][2], a: 1 };

    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      if (h.length !== 6 && h.length !== 8) return null;
      if (!/^[0-9a-f]+$/.test(h)) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      };
    }

    var m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var p = m[1].split(/[\s,/]+/).filter(function (x) { return x !== ''; });
      if (p.length < 3) return null;
      var conv = function (v) {
        if (v.indexOf('%') !== -1) return clamp(Math.round(parseFloat(v) * 2.55), 0, 255);
        return clamp(Math.round(parseFloat(v)), 0, 255);
      };
      var r = conv(p[0]), g = conv(p[1]), b = conv(p[2]);
      var a = 1;
      if (p.length > 3) {
        a = p[3].indexOf('%') !== -1 ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
        if (isNaN(a)) a = 1;
      }
      return { r: r, g: g, b: b, a: clamp(a, 0, 1) };
    }

    m = s.match(/^hsla?\(([^)]+)\)$/);
    if (m) {
      var q = m[1].split(/[\s,/]+/).filter(function (x) { return x !== ''; });
      if (q.length < 3) return null;
      var hue = ((parseFloat(q[0]) % 360) + 360) % 360;
      var sat = clamp(parseFloat(q[1]) / 100, 0, 1);
      var lig = clamp(parseFloat(q[2]) / 100, 0, 1);
      var rgb = hslToRgb(hue, sat, lig);
      var al = 1;
      if (q.length > 3) {
        al = q[3].indexOf('%') !== -1 ? parseFloat(q[3]) / 100 : parseFloat(q[3]);
        if (isNaN(al)) al = 1;
      }
      return { r: rgb.r, g: rgb.g, b: rgb.b, a: clamp(al, 0, 1) };
    }

    return null;
  }

  function hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    return {
      r: clamp(Math.round((r + m) * 255), 0, 255),
      g: clamp(Math.round((g + m) * 255), 0, 255),
      b: clamp(Math.round((b + m) * 255), 0, 255)
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function toRgbaString(c) {
    return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + (Math.round(c.a * 1000) / 1000) + ')';
  }

  function toHexString(c) {
    var f = function (n) {
      var h = clamp(Math.round(n), 0, 255).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return '#' + f(c.r) + f(c.g) + f(c.b);
  }

  function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(c) {
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function classify(c) {
    var l = relativeLuminance(c);
    var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
    var sat = max === 0 ? 0 : (max - min) / max;
    if (max < 24) return 'veryDark';
    if (l < 0.06) return 'veryDark';
    if (max < 70 && sat < 0.35) return 'dark';
    if (l < 0.16) return 'dark';
    if (l > 0.82) return 'veryLight';
    if (l > 0.55) return 'light';
    if (l > 0.32) return 'medium';
    return 'dark';
  }

  function saturation(c) {
    var max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
    if (max === 0) return 0;
    return (max - min) / max;
  }

  function isNeutral(c) {
    return saturation(c) < 0.14;
  }

  function isAccent(c) {
    var s = saturation(c);
    var l = relativeLuminance(c);
    if (s > 0.35 && l > 0.03 && l < 0.75) return true;
    var hsl = rgbToHsl(c.r, c.g, c.b);
    return hsl.s > 0.45 && hsl.l >= 0.28 && hsl.l <= 0.68;
  }

  function mix(a, b, t) {
    return {
      r: clamp(Math.round(a.r + (b.r - a.r) * t), 0, 255),
      g: clamp(Math.round(a.g + (b.g - a.g) * t), 0, 255),
      b: clamp(Math.round(a.b + (b.b - a.b) * t), 0, 255),
      a: a.a + (b.a - a.a) * t
    };
  }

  function lighten(c, t) { return mix(c, { r: 255, g: 255, b: 255, a: c.a }, t); }
  function darken(c, t) { return mix(c, { r: 0, g: 0, b: 0, a: c.a }, t); }

  var PALETTES = {
    // Surfaces are spread far enough apart that each elevation step is actually
    // visible (>=1.12 contrast between neighbours). A tighter ramp produced
    // neighbours only ~1.04 apart, which is indistinguishable in practice and
    // made themed cards and search boxes disappear into the page.
    dark: {
      canvas: { r: 15, g: 15, b: 15, a: 1 },
      surface: { r: 28, g: 28, b: 28, a: 1 },
      surfaceAlt: { r: 46, g: 46, b: 46, a: 1 },
      raised: { r: 69, g: 69, b: 69, a: 1 },
      text: { r: 245, g: 245, b: 245, a: 1 },
      textDim: { r: 178, g: 178, b: 178, a: 1 },
      border: { r: 62, g: 62, b: 62, a: 1 },
      link: { r: 77, g: 163, b: 255, a: 1 }
    },
    light: {
      canvas: { r: 255, g: 255, b: 255, a: 1 },
      surface: { r: 241, g: 241, b: 241, a: 1 },
      surfaceAlt: { r: 229, g: 229, b: 229, a: 1 },
      raised: { r: 214, g: 214, b: 214, a: 1 },
      text: { r: 16, g: 16, b: 16, a: 1 },
      textDim: { r: 92, g: 92, b: 92, a: 1 },
      border: { r: 207, g: 207, b: 207, a: 1 },
      link: { r: 15, g: 96, b: 212, a: 1 }
    }
  };

  function ensureContrast(fg, bg, minRatio, towardDark) {
    var guard = 0;
    var base = { r: fg.r, g: fg.g, b: fg.b, a: fg.a };
    while (contrastRatio(base, bg) < minRatio && guard < 24) {
      base = towardDark ? darken(base, 0.08) : lighten(base, 0.08);
      guard++;
    }
    base.a = fg.a;
    return base;
  }

  // Absolute tone buckets flatten every light surface onto the same color, which
  // erases elevation: a white card on a white page has no visible edge. Real theme
  // engines map a surface relative to what it sits on, so a child that was lighter
  // than its parent stays lighter, and vice versa.
  //
  // `srcParent`  the ORIGINAL background the element sat on, before theming.
  // `mappedParent` the background that original mapped to. Null for the page root,
  //   in which case the absolute mapping is used.
  //
  // Walking the ramp by parent-relative direction (not absolute tone) is what keeps
  // a white-on-white search box visible instead of painting it the page color.
  function mapSurface(input, mode, srcParent, mappedParent, forceStep) {
    var c = parse(input);
    if (!c || c.a === 0) return input;
    var p = PALETTES[mode];
    var ramp = [p.canvas, p.surface, p.surfaceAlt, p.raised];

    var abs = mapColor(toRgbaString(c), mode, 'bg');
    if (!mappedParent || !srcParent || srcParent.a < 0.05) return abs;

    var srcL = relativeLuminance(c);
    var parentSrcL = relativeLuminance(srcParent);
    // "Further from the canvas" is theme-independent; "lighter" is not. On a dark
    // page a surface that is *darker* than its parent is the raised one, so
    // compare distance from the canvas rather than raw lightness.
    var canvasL = relativeLuminance(p.canvas);
    var srcDist = Math.abs(srcL - canvasL);
    var parentDist = Math.abs(parentSrcL - canvasL);
    var delta = srcDist - parentDist;
    var rawDelta = srcL - parentSrcL;
    if (mode === 'light') rawDelta = -rawDelta;
    // A shadowed or bordered element keeps its own step even when its color
    // matches its parent exactly. This is the Google search pill case: same white,
    // but the shadow is what makes it visible, so tone alone cannot decide.
    if (Math.abs(delta) < 0.004 && !forceStep) return abs;

    // Position of the mapped parent on the ramp. Nearest-luminance matching is
    // unreliable here because the ramp spans only ~0.005..0.023, so match on the
    // exact color when the parent came from the ramp itself.
    var parentIdx = 0;
    for (var i = 0; i < ramp.length; i++) {
      if (ramp[i].r === mappedParent.r && ramp[i].g === mappedParent.g && ramp[i].b === mappedParent.b) {
        parentIdx = i;
        break;
      }
      if (i === ramp.length - 1) {
        var best = Infinity;
        for (var j = 0; j < ramp.length; j++) {
          var d = Math.abs(relativeLuminance(ramp[j]) - relativeLuminance(mappedParent));
          if (d < best) { best = d; parentIdx = j; }
        }
      }
    }

    var last = ramp.length - 1;
    var target = forceStep
      ? (forceStep > 0 ? parentIdx + 1 : parentIdx - 1)
      : (rawDelta > 0 ? parentIdx + 1 : parentIdx - 1);

    // If stepping that way runs off the ramp, step the other way instead. A child
    // the page deliberately painted a different shade must stay visible against its
    // parent; collapsing them onto one color is exactly the bug this avoids
    // (a white search box on a white page turning the same color as the body).
    if (target < 0) target = parentIdx < last ? parentIdx + 1 : 0;
    if (target > last) target = parentIdx > 0 ? parentIdx - 1 : last;
    if (target === parentIdx) return abs;

    var out = { r: ramp[target].r, g: ramp[target].g, b: ramp[target].b, a: c.a };
    return toRgbaString(out);
  }

  function mapColor(input, mode, role) {
    var c = parse(input);
    if (!c || c.a === 0) return input;
    role = role || 'bg';

    if (mode === 'dark') return mapDark(c, role);
    return mapLight(c, role);
  }

  function mapDark(c, role) {
    var p = PALETTES.dark;
    var tone;

    if (isAccent(c) && role !== 'bg') {
      var hsl = rgbToHsl(c.r, c.g, c.b);
      var shifted = hslToRgb(hsl.h, Math.min(1, hsl.s * 0.92), clamp(hsl.l * 1.08 + 0.06, 0.32, 0.72));
      shifted.a = c.a;
      return toRgbaString(shifted);
    }

    tone = classify(c);

    if (role === 'text') {
      if (tone === 'veryLight' || tone === 'light') return toRgbaString(p.text);
      if (tone === 'medium') return toRgbaString(p.textDim);
      return toRgbaString(p.text);
    }

    if (role === 'border') {
      if (tone === 'veryDark' || tone === 'dark') return toRgbaString(p.border);
      return toRgbaString({ r: 70, g: 70, b: 70, a: c.a });
    }

    if (tone === 'veryLight') return toRgbaString(p.canvas);
    if (tone === 'light') return toRgbaString(p.surface);
    if (tone === 'medium') return toRgbaString(p.surfaceAlt);
    return toRgbaString(p.raised);
  }

  function mapLight(c, role) {
    var p = PALETTES.light;
    var tone;

    if (isAccent(c) && role !== 'bg') {
      var hsl = rgbToHsl(c.r, c.g, c.b);
      var shifted = hslToRgb(hsl.h, Math.min(1, hsl.s * 1.02), clamp(hsl.l * 0.94, 0.24, 0.62));
      shifted.a = c.a;
      return toRgbaString(shifted);
    }

    tone = classify(c);

    if (role === 'text') {
      if (tone === 'veryDark' || tone === 'dark') return toRgbaString(p.text);
      if (tone === 'medium') return toRgbaString(p.textDim);
      return toRgbaString(p.text);
    }

    if (role === 'border') {
      if (tone === 'veryDark' || tone === 'dark') return toRgbaString(p.border);
      return toRgbaString({ r: 226, g: 226, b: 226, a: c.a });
    }

    if (tone === 'veryDark') return toRgbaString(p.canvas);
    if (tone === 'dark') return toRgbaString(p.surface);
    if (tone === 'medium') return toRgbaString(p.surfaceAlt);
    return toRgbaString(p.raised);
  }

  function bestTextOn(bg, mode) {
    var darkText = PALETTES.dark.text;
    var lightText = PALETTES.light.text;
    var cDark = contrastRatio(darkText, bg);
    var cLight = contrastRatio(lightText, bg);
    return cDark >= cLight ? toRgbaString(darkText) : toRgbaString(lightText);
  }

  root.NeoColor = {
    parse: parse,
    toRgbaString: toRgbaString,
    toHexString: toHexString,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    classify: classify,
    saturation: saturation,
    isNeutral: isNeutral,
    isAccent: isAccent,
    mix: mix,
    lighten: lighten,
    darken: darken,
    hslToRgb: hslToRgb,
    rgbToHsl: rgbToHsl,
    ensureContrast: ensureContrast,
    mapColor: mapColor,
    mapSurface: mapSurface,
    bestTextOn: bestTextOn,
    PALETTES: PALETTES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.NeoColor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
