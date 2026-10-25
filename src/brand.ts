// Crunchyroll's orange "eye" symbol, kept inline so the managed local service has no artwork
// file to locate after it is packed into a single executable. The two paths are the mark itself;
// unlike the old hand-drawn C tile, this stays recognizable at the 36–48 px sizes Izumi uses.
const mark = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '<path fill="#f47521" d="M95.861 43.517C88.802-1.229 28.681-10.321 8.311 30.026-5.783 58.809 13.733 92.626 45.598 95.595c-.246.138 11.835.216 5.657-.32-2.384-.191-5.999-.995-8.814-1.959C6.051 80.491 6.181 30.216 42.617 17.612c23.974-8.48 50.92 8.586 53.287 33.766.096 1.138.173 1.413.319 1.15.27-.481.038-6.243-.362-9.011z"/>',
  '<path fill="#f47521" d="M88.716 53.078c-8.249 8.928-23.788 3.74-25.163-8.21-.951-6.583 3.482-13.149 9.804-15.499C26.439 7.838 3.291 82.524 55.402 89.897 76.571 91.661 93.966 72.754 90.013 52c-.052-.085-.636.4-1.297 1.078z"/>',
  '</svg>',
].join('')

export const CRUNCHYROLL_ICON = `data:image/svg+xml,${encodeURIComponent(mark)}`

