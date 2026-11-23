# Pictures

A place's card can carry one picture, and so can the trip itself (its cover). A good picture lets someone recognize
the door they're looking for, or look forward to the thing they came for. A trip looks right in the app with no
pictures at all, so a card only gets one when there's a good one that the group is allowed to use.

Read `get_trip_guide` first if you haven't. Every example here is invented.

## Which places get one

- **The trip's cover:** one picture that says where this is.
- **The places the trip is built around:** the stay (when the host's listing or the group has a photo they may use),
  the thing they came for, the booked tour's landscape.
- **Sights and activities,** where seeing it helps someone recognize it or want to go.
- **A restaurant or a bar** only when it's a destination in itself and a usable picture of it exists. That's rare.
- **Not the practical places.** Nobody needs a photo of an ATM.

On a trip with a few hundred places, a few dozen have pictures. An event shows its place's picture; give an event
its own only when it has no place.

If a place already has a picture, leave it, unless the person asks you to change it. Someone may have put it there
by hand.

## What makes a picture right

- **It shows this place.** Not one like it, not the city in general. Read the file's own description to be sure it's
  the same building, the same viewpoint, the same beach.
- **It shows what someone arriving would see:** the front, the view from the terrace, the trail at the pass.
- **It still looks like that.** Avoid pictures from before a renovation, or of a season the group won't see when the
  place looks very different then.
- **Landscape format,** with the subject clear at the size of a card.
- **No watermarks, borders, captions or collages.** People in the frame are fine; a portrait of someone is not.
- **Never a generated image of a real place.** It shows something that doesn't exist, and someone will look for it.

## Where a picture may come from

Only sources that let the group use it:

- **`find_picture`,** for a real place: a free photo of it from Wikimedia Commons, kept only when the license is free
  and Wikidata's own record of the place is near the coordinates given. Its `url`, `license`, `credit` and `source`
  go to `set_picture` unchanged. It finds none for most small places, and then there's none.
- **Openly licensed collections,** such as Wikimedia Commons: public domain, CC0, CC BY and CC BY-SA files.
- **Free photo libraries whose own license allows reuse without asking.** The license's name goes in `license`.
- **The place's own press or media page,** when it says the pictures may be used.
- **The group's own photos** (below).

Never from map and review sites, social media, stock libraries, a hotel's or a restaurant's website without
permission, or an image search result whose license you haven't read on its own page. "Found on the web" is not a
license. Licenses that forbid commercial use or changes (NC, ND) are refused.

## What you record with it

A picture from a licensed source is refused without these. The app lists them on its credits page, which is how the
license's terms are met.

| Field | What goes in it |
|---|---|
| `credit` | The author exactly as the source names them: a name or a username. Not the name of the website. |
| `license` | Its short name with the version: `CC BY-SA 4.0`, `CC BY 2.0`, `CC0`, `Public domain`. For the group's own photo, `own`. For a press picture, `permission`. |
| `source` | The address of the page that shows the picture with its author and license (the file's page, not the image file). For `own`, leave it out. |

## Size, and how it gets there

- One image per card: at most **1600 pixels on the long side and 600 kB.** Anything larger is refused with those
  limits in the error. JPEG, PNG, WebP or AVIF.
- **By address.** Give `set_picture` the address of the image file (`url`, https only). The app fetches it once and
  keeps its own copy; it never links to the source afterwards. The address must lead straight to an image, not to
  a page about one. For the large collections that serve scaled copies, the app asks for a size that fits by
  itself. Anywhere else, give the address of a copy that's already within the limits.
- **From your own files.** If you can run commands (you have a shell and the picture is a file there),
  `picture_upload` answers a one-use upload link, good for 15 minutes, with the command to send the file. The link
  is used up by its first upload, even one that is refused (too big, not a picture): fix the file, then ask for a
  new link.
- **How often:** at most 20 pictures fetched by address and 20 upload links a minute, for your account. Past that a
  call is refused and says when to try again: wait that long, then go on.
- **A photo the person attached to the conversation.** You can see it, and you can't send it: `set_picture` takes
  an address, not a file. Hand the person the link `open_in_app` makes with `add_photo: true`: it opens that card
  in the app ready for them to add the photo there; the app sizes it for them, and their own photo's `license` is `own`.
- **What's inside the file stays inside it.** A file sent by address or by upload link is kept exactly as it is,
  including what a camera wrote into it: where and when the photo was taken, the device. Everyone on the trip can
  open the picture. Before you send a person's own photo from your files, remove that data unless they asked for
  it to stay. A photo added in the app has it removed for them.
- Pictures are kept in the trip's storage and count against its host's allowance (a free account holds 1 GB across
  its trips). A picture is usually 100 to 400 kB, so a few dozen are nothing; a few hundred add up and help nobody.

```json example:set_picture
{
  "trip_id": "TRIP_ID",
  "summary": "Added a picture to the Miradouro do Exemplo card",
  "place_id": "miradouro-do-exemplo",
  "url": "https://images.example/1280px-Miradouro_do_Exemplo_at_dusk.jpg",
  "credit": "M. Example",
  "license": "CC BY-SA 4.0",
  "source": "https://images.example/wiki/File:Miradouro_do_Exemplo_at_dusk.jpg"
}
```

For the trip's cover, send `"cover": true` instead of a `place_id`.

## When there's no good picture

Then there's no picture. Don't settle for a near miss, and don't tell the person a place has no picture as if
something were missing: say it only if they asked for one.
