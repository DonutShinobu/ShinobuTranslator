# Research: Pixiv Multi-Image DOM Structure

- **Query**: DOM structure of Pixiv multi-image artwork pages
- **Scope**: external (browser inspection via CDP)
- **Date**: 2026-05-23

## Findings

### Two Viewing Modes

Pixiv multi-image artwork pages have **two distinct viewing modes**:

#### Mode 1: Normal Artwork Page (Single Image View)
- URL: `https://www.pixiv.net/artworks/{id}` (no hash)
- Shows **only the first page** (p0) of a multi-image work
- There is **NO in-page navigation** to switch between pages in this mode
- The "1/44" page indicator in the top-right of the image is clickable and opens the **Preview Panel**
- The "Read Work" button below the image enters **Mode 2**

#### Mode 2: Manga/Reading Mode (Multi-Page View)
- URL: `https://www.pixiv.net/artworks/{id}#1` (hash triggers this mode)
- Triggered by: clicking "Read Work" button, clicking a thumbnail in the Preview Panel, or setting URL hash `#1`
- Shows all pages in a **horizontal scrollable spread view** (2 pages per spread, like a book)
- Has a top bar with close button and page count, and a bottom bar with page slider

### DOM Structure: Normal Artwork Page (Mode 1)

```
section.sc-7d1a8035-1
  div.sc-7d1a8035-0
    div.sc-d2b8e292-1               (image viewer container, position: relative, z-index: 0)
      figure.sc-d2b8e292-2          (the main figure element)
        div[role=presentation].sc-1d29d0c1-1   (presentation wrapper)
          div.sc-1b51c573-0          (LEFT: page indicator overlay, position: absolute, z-index: 1)
            div.sc-1b51c573-1
              div
                div.sc-ae1a3eae-0
                  div[aria-label="预览"].sc-71e93a98-2.gtm-manga-viewer-open-preview
                    div.sc-71e93a98-0
                      span                     "1/44" (page indicator text)
          div.sc-1d29d0c1-2          (CENTER: image container, position: relative)
            div[role=presentation].sc-fddeba56-0
              a.sc-fddeba56-3         (link to original image, target="_blank")
                img.sc-fddeba56-1     (THE MAIN IMAGE, src: *_p0_master1200.jpg)
          div.sc-1d29d0c1-0          (RIGHT: empty spacer, 912x1323, pointer-events: none)
      div#manga-viewer-close-anchor  (anchor for closing manga viewer)
      div (empty)
      div.sc-b2a66945-4              (separator, 1px)
      div (empty)
      div.sc-33b4c2d3-0              (sticky action bar)
        div.sc-b2a66945-2
          div.sc-b2a66945-0          (spacer)
          div.sc-b2a66945-1
            section.sc-e18a6d7c-0    (action buttons container)
              div: menu button (3 dots)
              div: share button (upload icon)
              div: bookmark button
              div: settings button
              button: "Like!"
      div.sc-b2a66945-4              (separator)
      figcaption.sc-d2b8e292-3       (work info: series, title, tags, etc.)
        button.sc-f8e29b57-0         "Read Work" button (912x112px, full width)
```

**Key selectors for Mode 1:**
| Element | Selector | Description |
|---|---|---|
| Main image | `figure img.sc-fddeba56-1` | The currently displayed image |
| Image link | `a.sc-fddeba56-3` | Wraps the img, links to original |
| Page indicator | `.gtm-manga-viewer-open-preview span` | Shows "1/44" |
| Preview button | `.gtm-manga-viewer-open-preview` | Opens preview panel |
| Read Work button | `.sc-f8e29b57-0` | Enters reading mode |
| Sticky action bar | `.sc-33b4c2d3-0` | Below the image |

### DOM Structure: Manga/Reading Mode (Mode 2)

```
div.sc-1fde1da8-0                    (full-screen overlay, position: fixed, z-index: 12, background: rgba(0,0,0,0.32))
  div.sc-1fde1da8-2                  (centered panel, 888x1288)
    div.sc-8532a46c-1                (panel content, 3 children)
      div.sc-8532a46c-4              (CLOSE BUTTON - X icon)
      div.sc-8532a46c-2              (TITLE BAR - "预览" text)

div.sc-2d9ec97-0                     (reading mode container, position: relative)
  div.sc-7199c030-0                  (main content, 1920x945, position: relative)
    div.sc-7199c030-1                (card container, position: absolute, scrollWidth: 46080)
      div.sc-7199c030-4 (x24)        (spread cards, each 1920x930, positioned horizontally)
        Card 0: info card with like/bookmark buttons
        Card 1-N: image cards with 2 pages each (spread view)
          div.sc-7199c030-5          (left page placeholder, 654px)
          a.gtm-expand-full-size-illust  (right page link)
            div[role=img].sc-456f0350-1  (lazy-loaded image area, 654x930)
              img.sc-456f0350-0          (lazy-loaded img, only present for visible pages)

  div.sc-3ca91ae9-0                  (navigation arrow, 104x104, position: absolute)
    div.sc-3ca91ae9-1                (arrow icon pointing left)

  div.sc-a456a65d-0                  (TOP BAR, position: fixed, top: 0, 1920x64)
    div.sc-a456a65d-1                (bar content)
      div.sc-a456a65d-2.gtm-manga-viewer-close-icon   (close button, LEFT arrow)
      div.sc-a456a65d-3.gtm-manga-viewer-close-icon   (page counter)
        div.sc-a456a65d-4
          div.sc-a456a65d-5          (mini thumbnail icon)
          div.sc-a456a65d-6          ("44" - total page count)

  div.sc-2d9ec97-1                   (BOTTOM BAR, position: fixed, bottom: 0, 1920x32)
    div.sc-51f2d7c7-0
      div.sc-51f2d7c7-1              (slider container)
        div.sc-51f2d7c7-2            (range input wrapper)
          label
            input.gtm-manga-viewer-change-page[type=range]  (page slider, min=1, max=45, step=2)
            span.sc-51f2d7c7-5       (page label, e.g. "1/44")
        div.sc-51f2d7c7-6            (controls)
          button.gtm-manga-viewer-change-direction  (reading direction toggle)
          button.gtm-manga-viewer-share-button       (share button)
```

**Key selectors for Mode 2:**
| Element | Selector | Description |
|---|---|---|
| Reading mode container | `.sc-2d9ec97-0` | Full reading mode |
| Image links | `.gtm-expand-full-size-illust` | Each page's link, has `data-page` attr |
| Page slider | `.gtm-manga-viewer-change-page` | Range input for navigation |
| Direction toggle | `.gtm-manga-viewer-change-direction` | Reading direction button |
| Close button | `.gtm-manga-viewer-close-icon` | Back to normal view |
| Page label | `.sc-51f2d7c7-5` | Shows "1/44" |

### Image Elements Details

#### Mode 1 (Normal View)
- Single `<img>` tag: `img.sc-fddeba56-1`
- **Always shows p0** (the first page)
- `src` format: `https://i.pximg.net/img-master/img/{date_path}/{id}_p0_master1200.jpg`
- Wrapped in `<a>` tag linking to original: `https://i.pximg.net/img-original/img/{date_path}/{id}_p0.jpg`
- The `<a>` tag has `target="_blank"` and an `onClick` React handler
- The `img` does NOT change when navigating pages - there is NO page navigation in Mode 1

#### Mode 2 (Reading Mode)
- Images are in `<a class="gtm-expand-full-size-illust">` tags
- Each link has `data-page` attribute (1-indexed, e.g. "1" = p0, "44" = p43)
- Each link has `href` pointing to the original image
- Images use **lazy loading**: visible pages have `<img>` tags, off-screen pages use empty `div[role=img]`
- Image `src` format (when loaded): `https://i.pximg.net/img-master/img/{date_path}/{id}_p{N}_master1200.jpg`
- Images are displayed at 654x930px each (2 per 1920px-wide spread)
- The reading order is **right-to-left** (Japanese manga style): page 1 appears on the RIGHT side

### Navigation Mechanism

#### Mode 1: Normal View
- **No page navigation available** - always shows the first page
- "1/44" indicator opens the Preview Panel (thumbnail grid)
- "Read Work" button enters Reading Mode
- Clicking the image opens the original in a new tab (via `<a target="_blank">`)
- ArrowRight/ArrowLeft keys navigate between **series works**, not pages

#### Mode 2: Reading Mode
- **Horizontal scroll** with virtual rendering
- 24 spread cards, each 1920px wide, laid out horizontally
- Total scroll width: 46080px (24 x 1920)
- Navigation methods:
  1. **Page slider** (range input, min=1, max=45, step=2) - `.gtm-manga-viewer-change-page`
  2. **Click navigation arrows** - `.sc-3ca91ae9-0` (center of screen, 104x104px)
  3. **Swipe/scroll** on the image area (horizontal scroll)
  4. **Preview panel** thumbnails - clicking a thumbnail scrolls to that page
- Reading direction is toggleable via `.gtm-manga-viewer-change-direction`
- The spread layout shows 2 pages at a time, right-to-left order
- Card 0 is an info card (like/bookmark buttons)
- Card 1 has page 44 on the right (and empty left for first spread)
- Last card has page 1 on the left (and empty right for last spread)

#### Preview Panel (accessible from both modes)
- Full-screen overlay: `.sc-1fde1da8-0` (position: fixed, z-index: 12)
- Close button: `.sc-8532a46c-4` (X icon)
- Title: "预览"
- Thumbnail grid: `ul.sc-4c726319-1` containing 44 `li` items
- Each thumbnail: `div.sc-4c726319-2` > `div.sc-20eee990-9` > `img.sc-20eee990-10`
- Thumbnail size: 128x128px
- Thumbnail `src` format: `https://i.pximg.net/c/128x128/img-master/img/{date_path}/{id}_p{N}_square1200.jpg`

### Potential UI Anchor Positions for "Translate All" Button

#### Option A: Normal View - Below the Image, Above the Sticky Bar
- **Position**: Between the image and the sticky action bar
- **Anchor element**: Before `.sc-33b4c2d3-0` (sticky bar)
- **Advantage**: Visible without scrolling, consistent with existing UI pattern
- **Disadvantage**: Only relevant for Mode 1 which shows only page 1

#### Option B: Normal View - In the Sticky Action Bar
- **Position**: Add a button to `.sc-e18a6d7c-0` section
- **Anchor element**: Inside the sticky bar, next to menu/share/bookmark buttons
- **Advantage**: Always visible (sticky), natural fit with action buttons
- **Disadvantage**: Limited space, might clutter the bar

#### Option C: Normal View - Replace/Augment the "Read Work" Button Area
- **Position**: The `.sc-f8e29b57-0` button area (912x112px)
- **Anchor element**: Add a secondary button next to "Read Work"
- **Advantage**: High visibility, logical placement (translation = reading action)
- **Disadvantage**: "Read Work" is the primary CTA, adding might confuse

#### Option D: Reading Mode - Top Bar
- **Position**: Add button to `.sc-a456a65d-1` (fixed top bar, 64px height)
- **Anchor element**: Next to the close button and page counter
- **Advantage**: Always visible in reading mode, natural for multi-page translation
- **Disadvantage**: Top bar is minimal/clean, adding button changes the aesthetic

#### Option E: Reading Mode - Bottom Bar
- **Position**: Add button to `.sc-51f2d7c7-0` (fixed bottom bar)
- **Anchor element**: Next to the page slider and controls
- **Advantage**: Consistent with other controls, accessible
- **Disadvantage**: Bottom bar is compact (32px height)

#### Recommended: Option C (Normal View) + Option D (Reading Mode)
- In normal view, add a "Translate All" button in the "Read Work" area
- In reading mode, add a "Translate All" button in the top bar
- This covers both user flows: quick translate from normal view, and translate while reading

### Pixiv Image URL Patterns

| Type | URL Pattern | Description |
|---|---|---|
| Master (display) | `https://i.pximg.net/img-master/img/{date}/{id}_p{N}_master1200.jpg` | Displayed in viewer |
| Original | `https://i.pximg.net/img-original/img/{date}/{id}_p{N}.jpg` | Full resolution (linked) |
| Square thumbnail | `https://i.pximg.net/c/128x128/img-master/img/{date}/{id}_p{N}_square1200.jpg` | Preview panel |
| Custom thumbnail | `https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/{date}/{id}_p0_custom1200.jpg` | Sidebar thumbnails |

Date path format: `YYYY/MM/DD/HH/mm/ss`

## Screenshots

- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-multi-page1.png` - Normal view, page 1
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-manga-viewer.png` - Preview panel opened
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-after-thumb-click.png` - After clicking thumbnail in preview
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-read-work.png` - Reading mode entered
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-reading-mode.png` - Reading mode full view
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-scrolled-past.png` - Scrolled past main image
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-hash-2.png` - After setting hash #2
- `.trellis/tasks/05-23-pixiv-multi-image/research/pixiv-slider-3.png` - After moving slider

## Caveats / Not Found

1. **Styled-components class names are hashed** (e.g., `sc-d2b8e292-2`) and WILL change between Pixiv deployments. These cannot be used as stable selectors. Use GTM class names (e.g., `gtm-manga-viewer-open-preview`, `gtm-expand-full-size-illust`) or `data-*` attributes instead.

2. **Normal view has NO page navigation** for multi-image works. The single `<img>` always shows p0. Users must enter Reading Mode or use the Preview Panel to see other pages.

3. **Reading mode uses virtual rendering**: only ~7 of 44 images have actual `<img>` tags at any time. Off-screen images are empty `div[role=img]` placeholders. A "Translate All" feature must account for lazy loading.

4. **Image rendering in reading mode**: The `div[role=img]` elements that lack `<img>` tags appear to use a rendering approach that does not populate the DOM with `<img>` until the image is near the viewport. This needs further investigation (possibly Canvas-based or CSS-based rendering).

5. **The `data-page` attribute on `.gtm-expand-full-size-illust` is 1-indexed**, while the image filename uses 0-indexed `p{N}`. `data-page="1"` corresponds to `p0`.

6. **CSS class stability**: The GTM-prefixed class names (e.g., `gtm-manga-viewer-open-preview`, `gtm-expand-full-size-illust`, `gtm-manga-viewer-change-page`) are used for analytics tracking and are MORE stable than the hashed styled-component classes. These should be preferred as selectors.

7. **Reading mode direction**: The default reading direction is right-to-left (RTL), following Japanese manga convention. This can be toggled via the direction button. A translation feature should consider both directions.
