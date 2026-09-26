# Process overview

## What I built

A room booking system for the ANU. You sign in your uni ID, find a free room,
lab or study desk, and book a time slot. The booking is stored in the
database, so it's persists after a reload, a redeploy, and everyone else's
bookings. You find free spaces on a 3D map of the real campus and drill down
inside it: campus, building, level, then the room's booking dialog.

## How I got here

**Keeping everything in the map.**
I'd asked for the app to be built around a 3D map of ANU
([`1e47035`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-am167/commit/1e47035)),
but in its first pass the agent made its own assumption about how booking
should work. It put a list below the campus map, and placed the floor plan
and booking form underneath the canvas on every building and room page. I
wanted the whole flow to stay inside the map, so I asked it to rework that
first version:

> I dont like having to scroll down to access the room management stuff, I
> would like to keep everything inside that map

Before rebuilding it, the agent asked three questions about the drill-down,
and I took its recommended answer each time. Now every stage happens inside
the map, with a floating panel and a dialog on top of it. Each stage is
still a real URL, so the back button and a reload still work. The tests for
the new stages were written first and failed before any markup changed.
Then I had a hostile reviewer agent, with none of the drafting context, go
through the change in Chrome. It found a real bug: signing in from a room's
dialog left the map stuck on "Loading". That was fixed. Another of its
findings didn't reproduce when checked by hand, so it was set aside
([`cf44a96`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-am167/commit/cf44a96)).

**Making the floors realistic, twice.**
The agent's first version of the floor generator followed its own idea of a
university layout: corridors lined with tutorial rooms. I asked it to rework
the floors to look more like what I had in mind: "a few meeting rooms and lab
rooms, and mostly desks/study spaces". I also asked for the database to keep
existing bookings when the layout changed. The agent rebuilt the generator
around a stair and lift core, a few rooms and individually bookable desks. On
every boot it now moves rooms onto the new plan, keeping any room with an
upcoming booking bookable until that booking is over
([`4793d93`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-am167/commit/4793d93)).

When I saw the revised layout, it had taken "mostly desks" too literally,
packing more than 10,000 desks into every free metre. I had to redirect it
again:

> i think you've dramtically overguessed the number of desks. you can roughly
> triple thr number of labs/meeting rooms and cut number of desks and study
> spaces by like 1/5 (20% the current amount)

The campus went from 116 rooms and 10,552 desks to 356 rooms and 2,284 desks.
The new numbers are held by tests that failed before the change, so the
layout can't drift back
([`fb068e0`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit7-am167/commit/fb068e0)).
