// SAMPLE seller reviews for the three team-run demo shops, so the options can be compared on reputation.
// They are written by the team and published as kind "sample": they are NOT World ID verified and NOT tied to an order,
// and the app labels them that way. Only reviews written through the app (delivered order + World ID check) are verified.
// daysAgo spreads them over the last two months; every review still expires 90 days after it is published.
const r = (rating, daysAgo, text) => ({ rating, daysAgo, text });
export const SAMPLE_REVIEWS = {
  voltforge: [
    r(5, 3, "Dispatched the same day and arrived in Mumbai in two days. Every part sealed and genuine."),
    r(5, 7, "Build arrived well packed with the GPU braced. Booted first time."),
    r(4, 12, "Fast delivery, but the cable management could have been tidier."),
    r(5, 16, "Asked a question about RAM compatibility and got a clear answer within an hour."),
    r(5, 21, "Exactly the parts listed, with proper invoices and full warranties."),
    r(4, 27, "A little pricier than others, but zero hassle and quick dispatch."),
    r(5, 33, "Second PC from them. Consistent quality, quick delivery."),
    r(4, 40, "Courier was a day late, but the shop kept me updated throughout."),
    r(5, 46, "Monitor and PC came together, both perfect. No dead pixels."),
    r(5, 55, "Honest about stock: told me upfront which part would take an extra day."),
  ],
  pixelbazaar: [
    r(5, 2, "Great value. Saved a good amount compared to other shops for the same performance."),
    r(4, 6, "Good price and solid parts, though delivery took four days to Pune."),
    r(3, 11, "PC was fine but the box was dented. Everything still worked."),
    r(4, 15, "Helpful seller, happy to haggle a little. Build works well."),
    r(5, 19, "Best price I found for a 1440p build. Arrived as described."),
    r(3, 24, "Slow replies on chat, but the order arrived complete."),
    r(4, 30, "Decent packing and genuine parts. Delivery was on the slower side."),
    r(4, 36, "Budget friendly and reliable. Would buy again for a second PC."),
    r(2, 43, "Wrong keyboard layout shipped at first; they fixed it, but it took a week."),
    r(4, 51, "Good deal overall. Thermal paste was already applied properly."),
    r(5, 58, "Very happy with the value. Runs everything I play smoothly."),
  ],
  rigroom: [
    r(5, 4, "Excellent high-end parts and a very clean build. Worth the wait."),
    r(3, 9, "Great build quality, but delivery to Bengaluru took almost a week."),
    r(4, 13, "Knowledgeable team; they suggested a better PSU for my GPU."),
    r(2, 18, "Used GPU worked, but the three-month warranty felt short for the price."),
    r(4, 23, "Liquid cooler installed neatly. Temperatures are great."),
    r(3, 29, "Good parts, slow updates on shipping status."),
    r(5, 35, "Top-tier components and careful packing. No complaints."),
    r(4, 41, "Solid enthusiast shop. Not the fastest, but they know their stuff."),
    r(3, 48, "PC works well, but one RAM stick needed reseating on arrival."),
    r(4, 57, "Good for high-end builds if you're not in a hurry."),
  ],
};
