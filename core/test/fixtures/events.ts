import type { CalendarEventLike } from '../../src/parser.ts';

/**
 * Anonymized copies of real reservation events from the company calendar.
 * Structure, labels, spacing and line breaks are preserved exactly; every
 * name, email, phone number, address and plate has been replaced.
 */

// Unfilled corporate NYC trip with congestion (modelled on TRP-04327, Wed 21 Oct 2026).
export const unfilledNycCongestion: CalendarEventLike = {
  id: 'evt_unfilled_nyc',
  status: 'confirmed',
  summary: 'HANDY TRANSPORTATION LLC CONFIRMATION:  is scheduled to pick up Pat Example (Corporate) from Example Law @ 1 Example Plaza, NYC, @ Wed, Oct 21 at 3:00 PM EDT, heading towards 10 Sample Ridge, Oakland, NJ. Flight Number: . Passenger Count: 1. Checked Bags: 0. Carry On Bags: 0. ',
  description: '  Customer: Pat Example (Corporate)\n  Email: assistant@example.com\n  Phone: 5550100000\n\nTrip: TRP-90001 (confirmed)\nPickup time: Wed, Oct 21 at 3:00 PM EDT\nPickup: Example Law @ 1 Example Plaza, NYC\nDrop-off: 10 Sample Ridge, Oakland, NJ\nPassengers: 1 · Bags: 0 checked, 0 carry-on\nRate: New York City - Congestion\n\n',
  location: 'Example Law @ 1 Example Plaza, NYC',
  start: { dateTime: '2026-10-21T15:00:00-04:00' },
  end: { dateTime: '2026-10-21T16:00:00-04:00' },
  attendees: [
    { email: 'support@example-company.test', organizer: true, self: true },
    { email: 'assistant@example.com' },
    { email: 'pat@example.com' },
  ],
};

// Assigned JFK pickup with car seat note and international flight.
export const assignedJfk: CalendarEventLike = {
  id: 'evt_assigned_jfk',
  status: 'confirmed',
  summary: 'HANDY TRANSPORTATION LLC CONFIRMATION: \nDriver: Dana Driver · 5550100001\nVehicle: Black Suburban (TEST001)\n\n** CAR SEATS: 1 convertible **\n is scheduled to pick up Sam Sample from John F. Kennedy International Airport (JFK) - Terminal 8, @ Wed, Oct 21 at 3:00 PM EDT, heading towards 6 Example ct, park ridge,nj 07656. Flight Number: Flight: QR701 - INTERNATIONAL\n. Passenger Count: 4. Checked Bags: 5. Carry On Bags: 2. ',
  description: '  Customer: Sam Sample\n  Email: sam@example.com\n  Phone: 5550100002\n\nTrip: TRP-90002 (confirmed)\nPickup time: Wed, Oct 21 at 3:00 PM EDT\nPickup: John F. Kennedy International Airport (JFK) - Terminal 8\nDrop-off: 6 Example ct, park ridge,nj 07656\nPassengers: 4 · Bags: 5 checked, 2 carry-on\nFlight: QR701 - INTERNATIONAL\nRate: JFK - JFK International Airport\n\nDriver: Dana Driver · 5550100001\nVehicle: Black Suburban (TEST001)\n\n\n** CAR SEATS: 1 convertible **\n',
  location: 'John F. Kennedy International Airport (JFK) - Terminal 8',
  start: { dateTime: '2026-10-21T15:00:00-04:00' },
  end: { dateTime: '2026-10-21T16:00:00-04:00' },
  attendees: [
    { email: 'support@example-company.test', organizer: true, self: true },
    { email: 'sam@example.com' },
    { email: 'dana.driver@example.com' },
  ],
};

// Assigned EWR drop-off with customer notes.
export const assignedEwrWithNotes: CalendarEventLike = {
  id: 'evt_assigned_ewr',
  status: 'confirmed',
  summary: 'HANDY TRANSPORTATION LLC CONFIRMATION: \nDriver: Chris Owner · 5550100003\nVehicle: 2024 Example Model Y - Silver (TEST002)\n is scheduled to pick up Lee Rider from 321 Sample st Ridgewood Nj 07450, @ Wed, Oct 21 at 8:15 AM EDT, heading towards Newark Liberty International Airport (EWR) - Terminal United. Flight Number: Flight: UA2776\n. Passenger Count: 2. Checked Bags: 2. Carry On Bags: 2. ',
  description: '  Customer: Lee Rider\n  Email: lee@example.com\n  Phone: 5550100004\n\nTrip: TRP-90003 (confirmed)\nPickup time: Wed, Oct 21 at 8:15 AM EDT\nPickup: 321 Sample st Ridgewood Nj 07450\nDrop-off: Newark Liberty International Airport (EWR) - Terminal United\nPassengers: 2 · Bags: 2 checked, 2 carry-on\nFlight: UA2776\nRate: EWR - Newark International Airport\n\nDriver: Chris Owner · 5550100003\nVehicle: 2024 Example Model Y - Silver (TEST002)\n\n\nCustomer notes:\n  Passengers: Second Passenger\n555-010-0005\n',
  location: '321 Sample st Ridgewood Nj 07450',
  start: { dateTime: '2026-10-21T08:15:00-04:00' },
  end: { dateTime: '2026-10-21T09:15:00-04:00' },
  attendees: [{ email: 'support@example-company.test', organizer: true, self: true }, { email: 'lee@example.com' }],
};

// Not a reservation: an internal note on the same calendar.
export const internalNote: CalendarEventLike = {
  id: 'evt_internal',
  status: 'confirmed',
  summary: 'Oil change - Suburban',
  description: 'Shop appointment',
  start: { dateTime: '2026-10-21T10:00:00-04:00' },
  end: { dateTime: '2026-10-21T11:00:00-04:00' },
};
