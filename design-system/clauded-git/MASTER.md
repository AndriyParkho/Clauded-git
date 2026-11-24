# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Clauded GIT
**Generated:** 2026-11-24 10:21:25
**Category:** Developer Tool / IDE
**Token files:** `tokens.json` (W3C Design Tokens Community Group JSON).
**CSS variables:** `tokens.css` (`:root` custom properties).
Token files are master-level only; `--page` overrides do not emit tokens.
**Design Dials:** Variance 3/10 (Centered / Minimal) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E293B` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#334155` | `--color-secondary` |
| On Secondary | `#FFFFFF` | `--color-on-secondary` |
| Accent/CTA | `#22C55E` | `--color-accent` |
| On Accent/CTA | `#0F172A` | `--color-on-accent` |
| Background | `#0F172A` | `--color-background` |
| Foreground | `#F8FAFC` | `--color-foreground` |
| Card | `#1B2336` | `--color-card` |
| Card Foreground | `#F8FAFC` | `--color-card-foreground` |
| Muted | `#272F42` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `#475569` | `--color-border` |
| Destructive | `#EF4444` | `--color-destructive` |
| On Destructive | `#000000` | `--color-on-destructive` |
| Ring | `#FFFFFF` | `--color-ring` |

**Color Notes:** Code dark + run green

### Typography

- **Heading Font:** JetBrains Mono
- **Body Font:** IBM Plex Sans
- **Mood:** code, developer, technical, precise, functional, hacker
- **Google Fonts:** [JetBrains Mono + IBM Plex Sans](https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #22C55E;
  color: #0F172A;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #F8FAFC;
  border: 2px solid #1E293B;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #0F172A;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #1E293B;
  outline: none;
  box-shadow: 0 0 0 3px #1E293B20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

**Pattern Name:** FAQ/Documentation Landing

- **Conversion Strategy:** Reduce support tickets. Track search analytics. Show related articles. Contact escalation path.
- **CTA Placement:** Search bar prominent + Contact CTA for unresolved questions
- **Section Order:** Hero with search bar > Popular categories > FAQ accordion > Contact/support CTA

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)

- ❌ Light mode default
- ❌ Slow performance

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile

---

## Adaptations clauded_git (prioritaires sur ce qui précède)

Le générateur vise surtout des pages web marketing. clauded_git est un outil local de dev, sombre et dense, donc les règles ci-dessous remplacent les parties qui ne collent pas. L'implémentation de référence est `web/src/styles.css` (variables dans `:root`).

### Ce qui est repris tel quel
- Palette « Developer Tool / IDE » : fond `#0F172A`, carte `#1B2336`, muted `#272F42`, texte secondaire `#94A3B8`, bordure de contrôle dérivée de `#475569`.
- Style minimaliste suisse : peu de couleur, hiérarchie par la typo et les surfaces, pas d'ombres décoratives.
- Typo : IBM Plex Sans pour le texte, JetBrains Mono pour le code, la marque, les titres de page et les petits libellés de section (majuscules, 11 px, espacés).
- Échelle d'espacement dense (2 / 4 / 8 / 12 / 16 / 24 / 32 px).

### Ce qui change
| Point | Générateur | clauded_git | Pourquoi |
|---|---|---|---|
| Couleur d'action | vert `#22C55E` | bleu `#60A5FA` (`--accent`), texte `#0F172A` dessus | le vert signifie déjà « succès / ajouté » (diffs, checks CI, issues ouvertes) |
| Succès / erreur / alerte | `#22C55E` / `#EF4444` | `#4ADE80` / `#F87171` / `#FBBF24` | plus lisibles en texte sur fond sombre (≥ 4.5:1 sur toutes les surfaces) |
| Taille de base | 16 px | 14 px, interligne 1.5 (1.6 dans le markdown) | app de bureau dense ; rien de lisible sous 11 px |
| Boutons | 12×24 px, radius 8 | 5×10 px (`small` 2×8), radius 6 | densité 8/10 |
| Inputs | 12×16 px, 16 px, bordure claire | 6×8 px, fond `--sunken`, focus bleu + halo 3 px | thème sombre, densité |
| Modales | fond blanc, radius 16 | `--panel-2`, radius 10, voile flouté | thème sombre |
| Focus | anneau blanc | anneau `#93C5FD` 2 px (`:focus-visible`) | visible sans être agressif sur une UI chargée |
| Ombres | alpha 0.05–0.15 | alpha 0.45–0.6 | invisibles sinon sur fond sombre |
| Motion | scroll reveal GSAP | transitions 150 ms sur couleurs/bordures, entrée des modales 180 ms, rien au scroll | outil de travail ; `prefers-reduced-motion` coupe tout |
| Page pattern | « FAQ/Documentation Landing » | sans objet | pas de landing page |

### Surfaces (du plus profond au plus élevé)
`--sunken #0B1222` (champs, code) → `--bg #0F172A` (fil, diff) → `--panel #131B2E` (barre latérale, en-têtes) → `--panel-2 #1B2336` (cartes, popovers) → `--raised #1E293B` (boutons) → `--hover #272F42`.

### Règles pour les nouveaux composants
- N'utiliser que les variables de `:root` ; aucune couleur en dur dans les composants.
- Sélection / élément actif : fond `--accent-soft` ou `--user` + liseré gauche de 2 px `--accent`.
- Statuts : pastille `.dot` ou texte coloré, toujours accompagné d'un libellé (pas de couleur seule).
- Icônes : glyphes typographiques monochromes (▸ ↗ ✓ ✗ ◷), jamais d'emoji couleur.

### Structure de l'interface
- **Rail de gauche** (248 px, repliable à 56 px avec ⌘B) : recherche (⌘K), navigation (Issues, Pull requests, Specs), onglets ouverts en liste verticale groupée par dépôt (icône du type, point d'état, titre, ligne de contexte), consommation et réglages en pied. Plus de barre d'onglets horizontale ni de liste de sessions par dépôt.
- **Palette de commandes** (⌘K) : aller à un onglet ou une page, nouveau chat dans un dépôt, reprendre une ancienne session Claude Code, actions d'interface.
- **En-tête d'onglet** sur une ligne : titre et contexte (dépôt, branche, état, pastilles GitHub) à gauche ; sélecteur de panneaux au centre (Issue · Diff · Logs · PR) ; menus à droite (Commandes, Git, Ouvrir) puis l'action principale de l'onglet.
- **Règle de regroupement** : un bouton visible n'est justifié que s'il sert à chaque visite (panneaux, action principale). Le reste va dans un menu nommé par son domaine. Un menu dont une action suit un job (merge) garde son contenu monté et montre l'état par une pastille sur son bouton.
- **Raccourcis** : ⌘K, ⌘B, ⌥1…⌥9, ⌥↑/⌥↓, ?, Échap. Toute action doit rester faisable au clavier.
- **Volets côte à côte** (jusqu'à 4) : le volet principal (page ou onglet) et des onglets à sa droite. ⌥-clic ou bouton ⧉ sur un onglet du rail, ⌘↵ dans la palette, ou glisser l'onglet sur un volet (bord droit : à côté ; centre : remplace). Le volet qui a le focus (liseré bleu en haut) reçoit les onglets choisis. Barre de volet : garder seul, fermer. Les volets et leurs proportions sont gardés d'une visite à l'autre.
- **Largeurs réglables** : rail, panneau latéral des onglets (normal et large), détail des issues et des PR, liste des fichiers du diff, frontières entre volets. Poignée de 8 px (liseré bleu au survol), flèches au clavier, double-clic pour revenir au défaut. Les largeurs sont gardées dans le navigateur.
- **Volet étroit** (requêtes de conteneur, pas de la fenêtre) : sous 980 px les menus de l'en-tête n'affichent que leur icône ; sous 820 px le panneau latéral devient un tiroir par-dessus le chat ; la barre d'état passe sur deux lignes plutôt que de tronquer ses sélecteurs.
